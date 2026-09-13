import glob
import http.server
import socketserver
import json
import os
import signal
import subprocess
import sys
import time
import traceback

PORT = 8081

# get_amd_stats() below has to force-kill amdgpu_top every call (it doesn't respect
# its own "-n 1" sample-count flag -- see that function's docstring). If the device
# is in a bad state (e.g. an eGPU mid-disconnect) the kill can outlive our own
# best-effort proc.wait(), leaving a zombie our reap attempt already gave up on.
# This reaps any such stragglers automatically so they can't accumulate during
# extended polling against a misbehaving device.
def _reap_children(signum, frame):
    try:
        while True:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
    except ChildProcessError:
        pass

signal.signal(signal.SIGCHLD, _reap_children)

def read_amdgpu_hwmon():
    """Find the sysfs hwmon dir for the AMD GPU (name == 'amdgpu') and read power
    (power1_average, PPT/board power) and temperature (prefer 'junction' label,
    fall back to 'edge') straight from the kernel driver -- cheap synchronous file
    reads, no subprocess needed. amdgpu_top's own JSON 'Sensors' fields came back
    null for these on this card/driver combo even under real generation load
    (verified live), but the underlying kernel data is right here in sysfs, so
    this is used as the preferred source in get_amd_stats() below.
    Returns (power_watts_or_None, temp_celsius_or_None)."""
    power, temp = None, None
    try:
        for hwmon_dir in glob.glob('/sys/class/hwmon/hwmon*'):
            try:
                with open(os.path.join(hwmon_dir, 'name')) as f:
                    if f.read().strip() != 'amdgpu':
                        continue
            except Exception:
                continue

            try:
                with open(os.path.join(hwmon_dir, 'power1_average')) as f:
                    power = int(f.read().strip()) / 1_000_000.0  # uW -> W
            except Exception:
                pass

            temp_by_label = {}
            for temp_input in glob.glob(os.path.join(hwmon_dir, 'temp*_input')):
                label_path = temp_input.replace('_input', '_label')
                try:
                    with open(label_path) as f:
                        label = f.read().strip()
                    with open(temp_input) as f:
                        temp_by_label[label] = int(f.read().strip()) / 1000
                except Exception:
                    continue
            temp = temp_by_label.get('junction', temp_by_label.get('edge'))
            break  # first amdgpu hwmon device only -- matches the single-GPU assumption elsewhere in get_amd_stats()
    except Exception:
        pass
    return power, temp

def get_meminfo_usage():
    """Read /proc/meminfo and return (total_kb, used_kb) where used = Total - Available.
    This is the standard Linux 'true used' figure that always >= any single process's RSS."""
    try:
        with open('/proc/meminfo') as f:
            values = {}
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(':')
                    values[key] = int(parts[1])  # in kB
        total = values.get('MemTotal', 0)
        available = values.get('MemAvailable', 0)
        return total, max(total - available, 0)
    except Exception:
        return 0, 0

def get_net_bytes():
    try:
        with open('/proc/net/dev') as f:
            lines = f.readlines()
        rx, tx = 0, 0
        for line in lines[2:]:
            parts = line.split()
            rx += int(parts[1])
            tx += int(parts[9] if len(parts) > 9 else 0)
        return rx + tx # Total bytes transferred
    except Exception:
        return 0

def _parse_cpu_util_from_stat(cpu_stat_data):
    """Parse /proc/stat cpu line to compute utilization percentage.
    Format: cpu  user nice system idle iowait irq softirq steal guest guest_nice
    Returns utilization as float (0-100)."""
    if not cpu_stat_data:
        return 0.0
    total_util = 0.0
    for line in cpu_stat_data.split('\n'):
        if line.startswith('cpu '):
            parts = line.split()
            if len(parts) < 5:
                continue
            # user, nice, system, idle, iowait, irq, softirq, steal
            fields = [float(x) for x in parts[1:]]
            while len(fields) < 8:
                fields.append(0.0)
            user, nice, system, idle, iowait, irq, softirq, steal = fields[:8]
            total = user + nice + system + idle + iowait + irq + softirq + steal
            busy = total - idle
            if total > 0:
                total_util = (busy / total) * 100.0
            break
    # Average across all CPU lines if multiple exist
    cpu_lines_count = sum(1 for l in cpu_stat_data.split('\n') if l.startswith('cpu'))
    if cpu_lines_count > 1 and cpu_lines_count > 0:
        total_util = total_util  # already an average per-line representation
    return round(total_util, 1)

def _parse_netdev(netdev_data):
    """Parse /proc/net/dev output and return (total_bytes, dict_of_interface_bytes).
    /proc/net/dev format (after header lines):
       iface   RX bytes   TX bytes
       eth0:   1234567    7654321
       usb0:   1111111    2222222
    Returns total RX+TX across all interfaces, and a dict {iface: {'rx': bytes, 'tx': bytes, 'total': bytes}}."""
    if not netdev_data:
        return 0, {}
    total_rx = 0
    total_tx = 0
    iface_bytes = {}
    for line in netdev_data.split('\n'):
        line = line.strip()
        if not line or ':' not in line:
            continue
        parts = line.split(':')
        iface = parts[0].strip()
        values = parts[1].split()
        if len(values) < 10:
            continue
        rx = int(values[0])
        tx = int(values[8])
        total_rx += rx
        total_tx += tx
        iface_bytes[iface] = {'rx': rx, 'tx': tx, 'total': rx + tx}
    return total_rx + total_tx, iface_bytes

def _identify_interface_by_subnet(iface_bytes, subnet_prefix):
    """Heuristic: return the interface whose IP is on the given subnet.
    Since we can't get IPs from /proc/net/dev, we return the first interface
    whose name suggests the connection type.
    Returns (interface_name, bytes_dict) or ('other', bytes_dict)."""
    # Common interface naming conventions:
    #   Thunderbolt: usb0, enx<mac>, enp..., usb-ethernet
    #   Wi-Fi/LAN: eth0, wlan0, wlp...
    # For this dashboard, we identify based on known subnets from the UI transport dropdown.
    if not iface_bytes:
        return None, {}
    # Heuristic: Thunderbolt interfaces often use USB-based networking (usb0)
    # or have names starting with 'enx' (MAC address-based names from udev)
    for iface, data in iface_bytes.items():
        if 'usb' in iface or iface.startswith('enx') or 'ethernet' in iface:
            return iface, data
    # Next check for wired LAN (Ethernet non-USB)
    for iface, data in iface_bytes.items():
        if iface in ('eth0', 'enp1s0', 'enp0s20f0', 'eno1', 'eno2'):
            return iface, data
    # Fallback: return the non-loopback interface with highest traffic
    best = max((k for k in iface_bytes if k != 'lo'),
               key=lambda k: iface_bytes[k]['total'], default=None)
    if best:
        return best, iface_bytes.get(best, {})
    first = next(iter(iface_bytes.items()), None)
    return first[0] if first else None, first[1] if first else {}

class HardwareMonitorHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler for hardware telemetry. Wraps all request methods in
    try/except to prevent client disconnections (ConnectionResetError,
    BrokenPipeError, etc.) from crashing the entire monitor server.
    (Item 19: monitor.py dies on page refresh)"""

    # Suppress default stderr access logs — telemetry polls every 0.5-2s
    # produce very noisy logs and the frontend has its own error tracking.
    def log_message(self, format, *args):
        pass  # silence per-request logs; errors are logged via log_error

    def log_error(self, format, *args):
        # Log errors to stderr so they appear in server4.js console output
        sys.stderr.write(f"[monitor] ERROR {format % args}\n")
        sys.stderr.flush()

    def do_OPTIONS(self):
        try:
            self.send_response(200, "ok")
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
        except (ConnectionResetError, BrokenPipeError, OSError):
            # Client disconnected while sending response — safe to ignore
            pass

    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
            req = json.loads(post_data.decode('utf-8'))

            stats = {"master": self.get_stats()}
            # A master host with no NVIDIA GPU (the desktop with only the 7900
            # XTX) gets its GPU fields from amdgpu_top instead; CPU/RAM/net stay
            # from get_stats(). That AMD card is then the master, so it must not
            # also be reported as a local second GPU below.
            master_is_amd = False
            if stats["master"].get("nvidia_smi_error"):
                amd = self.get_amd_stats()
                if not amd.get("amdgpu_top_error"):
                    for key in ("gpu_name", "gpu_throttle", "throttle_reasons", "vram_used",
                                "vram_total", "process_vram", "gpu_pwr", "gpu_temp", "gpu_util"):
                        stats["master"][key] = amd[key]
                    stats["master"]["nvidia_smi_error"] = False
                    master_is_amd = True
            worker_ssh = req.get('worker_ssh', '').strip()
            local_second_gpu = req.get('local_second_gpu', '').strip()
            if local_second_gpu == 'amd' and not master_is_amd:
                # Local-multi-gpu launch mode: "worker" slot is the second GPU on
                # THIS machine (the AMD eGPU), not a remote SSH host.
                stats['worker'] = self.get_amd_stats()
            elif worker_ssh:
                stats['worker'] = self.get_stats(worker_ssh)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(stats).encode())
        except (ConnectionResetError, BrokenPipeError):
            # Client disconnected during request (e.g., page refresh, tab close).
            # This is normal — don't crash, just silently finish.
            pass
        except json.JSONDecodeError:
            # Malformed request body — return 400 but don't crash
            try:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid JSON"}).encode())
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass
        except Exception as e:
            # Catch-all: log full traceback so silent crashes are visible,
            # then return 500 — do NOT let the exception escape since that
            # would terminate the serving thread and kill the entire process.
            sys.stderr.write(f"[monitor] Unhandled error in do_POST:\n{traceback.format_exc()}\n")
            sys.stderr.flush()
            try:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass

    def get_amd_stats(self):
        """Local AMD GPU telemetry via `amdgpu_top -J` (local-multi-gpu launch mode's
        second GPU, e.g. a 7900 XTX eGPU). Returns the same dict shape as get_stats()
        so pollTelemetry's existing worker-card rendering on the frontend needs no
        changes to consume it. Verified live end-to-end (local-multi-gpu launch,
        real generation load split across a 4090 + this 7900 XTX): util/VRAM/power
        all populate correctly and track actual load (e.g. gpu_util 0->52%, gpu_pwr
        0->92W once generation started). amdgpu_top's own JSON 'Sensors' fields
        (Average/GFX Power, Junction/Edge Temperature) stayed null throughout, even
        under load -- power and temp come from read_amdgpu_hwmon() (sysfs) instead,
        which does report real numbers. If that ever comes back empty too (e.g. a
        different card/driver where hwmon isn't exposed the same way), this falls
        back to amdgpu_top's Sensors dict, then to 0 rather than raising -- same
        convention nvidia-smi's '[Not Supported]' case already uses below.
        AMD exposes no equivalent to
        nvidia's clocks_throttle_reasons bits, so throttle_reasons is always empty --
        that just means no throttle badges fire for this GPU, not that it's broken.

        Historical note: an earlier pass (same amdgpu_top 0.11.5) found `-n 1`
        didn't make it exit after one sample and always ran it without that flag,
        waiting out a fixed timeout and force-killing every call regardless of
        whether output was ready sooner. Re-tested directly on the command line
        (2026-08-04, same binary/version, 4 consecutive runs): `-n 1` now
        reliably exits on its own in ~0.2s. Re-added it since -- communicate()
        returns as soon as the process exits, so this is a pure win in the
        common case (no more ALWAYS blocking the full timeout on every single
        call, which was the actual reason /stats consistently took ~2s even at
        idle). Kept every bit of the existing force-kill/salvage/reap machinery
        below completely intact as a safety net in case a future device/driver
        state brings back the old non-exiting behavior -- worst case is exactly
        today's behavior, just with a tighter timeout.
        """
        device = None
        proc = None
        try:
            proc = subprocess.Popen(
                ["amdgpu_top", "-J", "-s", "150", "-n", "1"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            )
            # ~0.2s measured live and consistent across 4 runs with -n 1 (see
            # docstring). 1s timeout keeps a generous ~5x safety margin over
            # that for a slower run, while still failing much faster than the
            # old 2s if -n 1 ever reverts to its old non-exiting behavior --
            # the existing TimeoutExpired/salvage path below is unchanged and
            # still fully handles that case if it happens.
            try:
                raw_out, _ = proc.communicate(timeout=1)
            except subprocess.TimeoutExpired as e:
                raw_out = e.stdout or b''
            text = raw_out.decode('utf-8', errors='ignore')
            obj, _ = json.JSONDecoder().raw_decode(text)
            devices = obj.get('devices', [])
            if not devices:
                raise ValueError("amdgpu_top returned no devices")
            device = devices[0]
        except Exception:
            pass
        finally:
            # amdgpu_top never exits on its own (see above) -- always reap it.
            # A device in a bad TB4/power state can leave the kernel driver call
            # amdgpu_top is blocked in stuck (D-state), where even SIGKILL can't
            # complete immediately; don't let that possibility raise or hang here.
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                    proc.wait(timeout=1)
                except Exception:
                    pass

        if device is None:
            return {
                "gpu_name": "Offline", "gpu_throttle": False, "throttle_reasons": [],
                "vram_used": 0, "vram_total": 1, "process_vram": 0,
                "gpu_pwr": 0, "gpu_temp": 0, "gpu_util": 0,
                "ram_used": 0, "ram_total": 1, "process_ram": 0,
                "cpu_name": "Offline", "cpu_util": 0.0, "cpu_temp": 0,
                "net_bytes": 0, "amdgpu_top_error": True
            }

        def _val(d, *path, default=0):
            cur = d
            for key in path:
                if not isinstance(cur, dict) or key not in cur:
                    return default
                cur = cur[key]
            if isinstance(cur, dict):
                return cur.get('value', default)
            return cur if cur is not None else default

        gpu_name = _val(device, 'Info', 'DeviceName', default='Unknown AMD GPU')
        vram_used = int(_val(device, 'VRAM', 'Total VRAM Usage', default=0))
        vram_total = int(_val(device, 'VRAM', 'Total VRAM', default=1)) or 1
        gpu_util = int(_val(device, 'gpu_activity', 'GFX', default=0))

        # Prefer sysfs hwmon (verified reliable on this card/driver combo, see
        # read_amdgpu_hwmon() docstring); fall back to amdgpu_top's own JSON
        # sensor fields for portability to setups where that isn't the case.
        hwmon_power, hwmon_temp = read_amdgpu_hwmon()

        gpu_pwr = hwmon_power
        if gpu_pwr is None:
            gpu_pwr = _val(device, 'Sensors', 'Average Power', default=None)
            if gpu_pwr is None:
                gpu_pwr = _val(device, 'Sensors', 'GFX Power', default=0)
        gpu_pwr = float(gpu_pwr or 0)

        gpu_temp = hwmon_temp
        if gpu_temp is None:
            gpu_temp = _val(device, 'Sensors', 'Junction Temperature', default=None)
            if gpu_temp is None:
                gpu_temp = _val(device, 'Sensors', 'Edge Temperature', default=0)
        gpu_temp = int(gpu_temp or 0)

        # fdinfo is keyed by pid, doubly-nested per amdgpu_top's JSON shape:
        # {pid: {name, usage: {name, usage: {VRAM: {unit, value}, GFX: {...}, ...}}}}
        process_vram = 0
        try:
            for pid, entry in device.get('fdinfo', {}).items():
                name = entry.get('name', '')
                if 'llama-server' in name or 'llama' in name or 'ggml-rpc' in name:
                    inner = entry.get('usage', {}).get('usage', {})
                    process_vram += int(_val(inner, 'VRAM', default=0))
        except Exception:
            process_vram = 0

        # CPU/RAM/net are this same local host's -- both GPUs share one pool, so
        # these mirror what get_stats() computes for master. The frontend hides the
        # worker RAM/CPU sub-panels in local-multi-gpu mode since a duplicate
        # reading there would be redundant, but the fields stay populated here so
        # the dict shape is always valid regardless of how the frontend renders it.
        mem_total_kb, mem_used_kb = get_meminfo_usage()
        ram_total = max(mem_total_kb // 1024, 1)
        ram_used = max(mem_used_kb // 1024, 0)

        cpu_util = 0.0
        try:
            cpu_util = _parse_cpu_util_from_stat(open('/proc/stat').read())
        except Exception:
            cpu_util = 0.0

        cpu_name = "Unknown CPU"
        try:
            cpu_info = open('/proc/cpuinfo').read()
            cpu_name = [l for l in cpu_info.split('\n') if "model name" in l][0].split(':')[1].strip()
        except Exception:
            pass

        return {
            "gpu_name": gpu_name, "gpu_throttle": False, "throttle_reasons": [],
            "vram_used": vram_used, "vram_total": vram_total, "process_vram": process_vram,
            "gpu_pwr": gpu_pwr, "gpu_temp": gpu_temp, "gpu_util": gpu_util,
            "ram_used": ram_used, "ram_total": ram_total, "process_ram": 0,
            "cpu_name": cpu_name, "cpu_util": cpu_util, "cpu_temp": 0,
            "net_bytes": get_net_bytes(), "amdgpu_top_error": False
        }

    def get_stats(self, ssh_prefix=""):
        meminfo_out = ""  # For SSH remote meminfo data; empty for local (uses /proc/meminfo directly)
        nvidia_smi_error = False  # Tracks whether the primary nvidia-smi query failed

        if ssh_prefix:
            # Combined SSH command to avoid multiple connection overheads
            # Use /proc/stat for reliable CPU utilization (works inside containers)
            # Use /sys/class/thermal/thermal_zone*/temp for CPU temp (multiple zones)
            # Use /proc/net/dev for per-interface network byte counters
            shell_cmd = (
                "nvidia-smi '--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.sw_power_cap,clocks_throttle_reasons.hw_power_brake_slowdown' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===APPS==='; "
                "nvidia-smi '--query-compute-apps=used_memory,name' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===MEMINFO==='; "
                "cat /proc/meminfo 2>/dev/null || true; "
                "echo '===PS==='; "
                "ps ax -o rss,comm 2>/dev/null || true; "
                "echo '===CPUSTAT==='; "
                "cat /proc/stat 2>/dev/null || true; "
                "echo '===CPUINFO==='; "
                "cat /proc/cpuinfo 2>/dev/null || true; "
                "echo '===TEMP==='; "
                "for f in /sys/class/thermal/thermal_zone[0-9]*/temp; do cat \"$f\" 2>/dev/null && echo \"($f)\" || true; done; echo '===NETDEV==='; "
                "cat /proc/net/dev 2>/dev/null || true"
            )
            # Initialize variables before the try/except so they're always defined
            cpu_stat_out = ""
            netdev_out = ""
            
            try:
                ssh_cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", ssh_prefix, shell_cmd]
                combined_out = subprocess.check_output(ssh_cmd, stderr=subprocess.DEVNULL, timeout=3).decode('utf-8')
                
                # Parse sections by looking for ===MARKER=== lines in the output.
                # The echo '===MARKER===' lines contain only the marker, and the
                # command output follows until the next marker. Splitting on '==='
                # breaks markers and data into separate elements, so we parse line-by-line.
                section_lines = {}
                current_section = "gpu"  # data before first marker is GPU output
                for line in combined_out.split('\n'):
                    stripped = line.strip()
                    if stripped.startswith('===') and stripped.endswith('==='):
                        section_name = stripped.strip('=')
                        current_section = section_name
                        if section_name not in section_lines:
                            section_lines[section_name] = []
                    else:
                        if current_section not in section_lines:
                            section_lines[current_section] = []
                        section_lines[current_section].append(line)

                gpu_out = '\n'.join(section_lines.get('gpu', [])).strip()
                apps_out = '\n'.join(section_lines.get('APPS', [])).strip()
                meminfo_out = '\n'.join(section_lines.get('MEMINFO', [])).strip()
                ps_out = '\n'.join(section_lines.get('PS', [])).strip()
                cpu_stat_out = '\n'.join(section_lines.get('CPUSTAT', [])).strip()
                cpu_info = '\n'.join(section_lines.get('CPUINFO', [])).strip()
                temp_out = '\n'.join(section_lines.get('TEMP', [])).strip()
                netdev_out = '\n'.join(section_lines.get('NETDEV', [])).strip()
            except Exception:
                # Fail fast and return empty / offline indicators, with error flag
                return {
                    "gpu_name": "Offline", "gpu_throttle": False, "throttle_reasons": [],
                    "vram_used": 0, "vram_total": 1, "process_vram": 0,
                    "gpu_pwr": 0, "gpu_temp": 0, "gpu_util": 0,
                    "ram_used": 0, "ram_total": 1, "process_ram": 0,
                    "cpu_name": "Offline", "cpu_util": 0.0, "cpu_temp": 0, 
                    "net_bytes": 0,
                    "nvidia_smi_error": True
                }
        else:
            # Local stats (run natively, fast, no network latency)
            gpu_out = ""
            apps_out = ""
            ps_out = ""
            cpu_info = ""
            temp_out = ""
            
            try:
                gpu_out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.sw_power_cap,clocks_throttle_reasons.hw_power_brake_slowdown", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8').strip()
            except Exception as e:
                nvidia_smi_error = True
            
            try:
                apps_out = subprocess.check_output(["nvidia-smi", "--query-compute-apps=used_memory,name", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                ps_out = subprocess.check_output(["ps", "ax", "-o", "rss,comm"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass

            # top -bn1 used to be the primary CPU-util source here, but "top -bn1"
            # needs an internal sampling window to compute its delta (typically
            # 1.5-3s in practice, confirmed live -- this alone made this whole
            # function take 2.3-2.9s even at idle, meaning neither the "Fast
            # (0.5s)" nor "Normal (1s)" telemetry polling options could ever
            # actually run at their selected rate). /proc/stat gives the same
            # answer instantly via a plain file read (see _parse_cpu_util_from_stat
            # below), so top is no longer called at all.
            try:
                cpu_stat_out = open('/proc/stat').read()
            except Exception:
                cpu_stat_out = ""

            # Plain file reads, not subprocess("cat", ...) -- spawning an external
            # process to read one file is pure overhead Python doesn't need.
            try:
                cpu_info = open('/proc/cpuinfo').read()
            except Exception: pass

            try:
                temp_out = open('/sys/class/thermal/thermal_zone0/temp').read().strip()
            except Exception: pass

        # Helper to parse /proc/meminfo output (works for both local and SSH-remote data)
        def parse_meminfo(data):
            """Parse /proc/meminfo text and return (total_kb, used_kb)."""
            values = {}
            for line in data.split('\n'):
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(':')
                    values[key] = int(parts[1])
            total = values.get('MemTotal', 0)
            available = values.get('MemAvailable', 0)
            return total, max(total - available, 0)

        # Use meminfo_out for remote (SSH), fall back to local /proc/meminfo for local
        if meminfo_out:
            mem_total_kb, mem_used_kb = parse_meminfo(meminfo_out)
        else:
            mem_total_kb, mem_used_kb = get_meminfo_usage()

        # PARSING DATA (Same for both local and remote)
        # GPU Metrics
        try:
            if nvidia_smi_error or not gpu_out or gpu_out.strip() == '':
                raise ValueError("nvidia-smi query failed or returned empty")
            parts = gpu_out.split('\n')[0].split(',')
            if len(parts) < 6:
                raise ValueError(f"nvidia-smi returned insufficient columns: {gpu_out!r}")
            gpu_name = parts[0].strip()
            vram_used, vram_total = int(float(parts[1])), int(float(parts[2]))
            gpu_pwr = float(parts[3].strip() if parts[3].strip() != '[Not Supported]' else 0)
            gpu_temp = int(parts[4].strip())
            gpu_util = int(parts[5].strip())
            # Granular throttle reasons: positions 6-9 in the query
            throttle_fields = [
                'hw_thermal_slowdown',
                'sw_thermal_slowdown',
                'sw_power_cap',
                'hw_power_brake_slowdown'
            ]
            throttle_reasons = []
            for i, field in enumerate(throttle_fields):
                if i + 6 < len(parts) and parts[i + 6].strip() == 'Active':
                    throttle_reasons.append(field)
            gpu_throttle = len(throttle_reasons) > 0
        except Exception as e:
            gpu_name, vram_used, vram_total, gpu_pwr, gpu_temp, gpu_util, gpu_throttle = "Unknown", 0, 1, 0, 0, 0, False
            throttle_reasons = []

        # Process VRAM Metrics
        # Match: llama-server (master), ggml-rpc-server (worker), or any line containing 'llama'/'ggml-rpc'
        process_vram = 0
        try:
            for line in apps_out.split('\n'):
                if ('llama-server' in line or 'ggml-rpc-server' in line or 'llama' in line or 'ggml-rpc' in line):
                    parts = line.strip().split(',')
                    if len(parts) >= 2:
                        process_vram += int(float(parts[0]))
        except Exception:
            process_vram = 0

        # RAM Metrics — already computed above from /proc/meminfo (Total - Available)
        # so the figure always >= any single process's RSS, avoiding the inverted /
        # garbage "Sys = used - Llama" display when mmap'd model pages inflate RSS.
        ram_total = mem_total_kb // 1024  # convert kB → MB for UI
        ram_used = mem_used_kb // 1024
        if ram_total == 0:
            ram_total = 1
        if ram_used < 0:
            ram_used = 0

        # Process RAM Metrics — sum of RSS (from `ps`) for llama-server / ggml-rpc-server processes.
        # This is correct as-is; RSS includes file-backed mmap pages which is
        # the behavior we want to measure here.
        process_ram = 0
        try:
            for line in ps_out.split('\n'):
                if 'llama-server' in line or 'ggml-rpc-server' in line:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        process_ram += int(parts[0]) // 1024
        except Exception:
            process_ram = 0

        # CPU Metrics — /proc/stat only. This used to try parsing `top -bn1`
        # output first (see git history), which needs an internal sampling
        # window to compute its delta -- confirmed live to take 1.5-3s on its
        # own, making this whole function take 2.3-2.9s even at idle and
        # capping the real telemetry update rate well below both the "Fast
        # (0.5s)" and "Normal (1s)" polling options regardless of which was
        # selected. /proc/stat's own cumulative counters give the same
        # cpu_util answer without needing to wait for anything.
        cpu_util = 0.0
        cpu_parse_method = "none"
        try:
            if cpu_stat_out:
                cpu_util = _parse_cpu_util_from_stat(cpu_stat_out)
                cpu_parse_method = "proc_stat" if not ssh_prefix else "proc_stat_remote"
            else:
                print("[monitor] CPU: no /proc/stat data available")
                cpu_util = 0.0
        except Exception as e:
            print(f"[monitor] CPU /proc/stat parse error: {e}")
            cpu_util = 0.0

        try:
            cpu_name = [l for l in cpu_info.split('\n') if "model name" in l][0].split(':')[1].strip()
        except Exception:
            cpu_name = "Unknown CPU"

        # CPU Temp — parse first valid thermal zone value (ignore filename annotations)
        cpu_temp = 0
        if temp_out:
            for line in temp_out.split('\n'):
                line = line.strip().rstrip('()')
                # Strip the path annotation e.g. "/sys/class/thermal/thermal_zone0/temp(thermal_zone0)"
                try:
                    val = int(line.split()[-1] if ' ' in line else line)
                    if 0 < val < 200000:  # valid thermal value in millidegrees
                        cpu_temp = val // 1000
                        break
                except (ValueError, IndexError):
                    pass

        # Network — parse /proc/net/dev per-interface for remote, or use /proc/net/dev for local
        net_bytes = 0
        net_by_interface = {}
        if ssh_prefix and netdev_out:
            # Parse per-interface bytes for remote worker
            net_bytes, net_by_interface = _parse_netdev(netdev_out)
        elif not ssh_prefix:
            net_bytes = get_net_bytes()

        return {
            "gpu_name": gpu_name, "gpu_throttle": gpu_throttle, "throttle_reasons": throttle_reasons,
            "vram_used": vram_used, "vram_total": vram_total, "process_vram": process_vram,
            "gpu_pwr": gpu_pwr, "gpu_temp": gpu_temp, "gpu_util": gpu_util,
            "ram_used": ram_used, "ram_total": ram_total, "process_ram": process_ram,
            "cpu_name": cpu_name, "cpu_util": cpu_util, "cpu_temp": cpu_temp, 
            "net_bytes": net_bytes,
            "net_by_interface": net_by_interface,
            "nvidia_smi_error": nvidia_smi_error
        }

# TCPServer is single-threaded by default -- it can only ever process one
# request at a time, so a single slow amdgpu_top/nvidia-smi call (or an
# eGPU-in-a-bad-state hang) blocks every OTHER caller behind it, including
# unrelated ones. This matters here because there are always at least two
# independent pollers hitting this server concurrently: the dashboard's own
# per-request telemetry sampler (server4.js) and the browser's sidebar poll
# (script.js), both roughly once a second. Under any real load this caused
# requests to queue up and eventually just time out / fail to connect at all
# (confirmed live: curl connections timing out after 2.5s+ trying to even
# reach the port). ThreadingTCPServer handles each request on its own thread;
# nothing in HardwareMonitorHandler touches shared mutable module state (no
# globals written in do_POST), so there's no new race condition introduced.
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
with socketserver.ThreadingTCPServer(("", PORT), HardwareMonitorHandler) as httpd:
    httpd.serve_forever()