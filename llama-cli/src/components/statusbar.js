import React from 'react';
import { Box, Text } from 'ink';
import { fmtUptime, portFromCommand } from '../format.js';

const TABS = [
  ['1', 'Monitor', true],
  ['2', 'Launch', true],
  ['3', 'Chat', false],
  ['4', 'Bench', false],
  ['5', 'History', false],
];

// Top line: brand + model + state + port + uptime + connection dot.
export function StatusBar({ mode, conn, server, modelUpSince }) {
  const running = server.state === 'ready';
  const port = portFromCommand(server.launchCommand);
  const uptime = modelUpSince ? fmtUptime(Date.now() - modelUpSince) : null;
  const stateColor = running ? 'green'
    : server.state === 'starting' || server.state === 'loading' ? 'yellow'
      : server.state === 'stopping' ? 'yellow'
        : 'gray';

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="blue">Llama CLI</Text>
          <Text dimColor>  {server.model || 'no model loaded'}</Text>
          <Text color={stateColor}>  [{server.state}]</Text>
          {running ? <Text dimColor>  :{port}</Text> : null}
          {running && uptime ? <Text dimColor>  up {uptime}</Text> : null}
        </Box>
        <Box>
          {conn === 'live' ? (
            <Text color="green">● </Text>
          ) : conn === 'reconnecting' ? (
            <Text color="yellow">◌ reconnecting</Text>
          ) : (
            <Text color="red">○ offline</Text>
          )}
          <Text dimColor>  Mission Control</Text>
        </Box>
      </Box>
      <Box>
        {TABS.map(([key, label, built], i) => (
          <Text key={key}>
            {i > 0 ? '  ' : ''}
            {mode === `mode${key}` ? (
              <Text bold color="bgBlue white"> {key} {label} </Text>
            ) : built ? (
              <Text dimColor> {key} {label} </Text>
            ) : (
              <Text color="gray"> {key} {label}· </Text>
            )}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// Bottom line: contextual key hints.
export function KeymapBar({ hints }) {
  return (
    <Box>
      <Text dimColor>
        {hints.map(([k, label], i) => `${i > 0 ? '  ' : ''}${k}: ${label}`).join('')}
      </Text>
    </Box>
  );
}
