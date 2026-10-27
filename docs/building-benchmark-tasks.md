# Building and maintaining benchmark tasks

How to build coding tasks for a private benchmark mined from your own repos,
and how to keep them trustworthy once results arrive. It is written for the
external harness that LL-Dash can front (see
[benchmarking.md](benchmarking.md#external-benchmark-integration-optional)),
but the method does not depend on a particular harness.

The benchmark this comes from is private, and so are its tasks. Every example
here is invented, mostly around one made-up recipe app. None is a real task.

## What a task is

- **A base commit:** the repo just before the fix.
- **A prompt:** what a user would say about the problem.
- **Hidden tests (the oracle):** tests the agent never sees, failing at the
  base and passing once the problem is fixed.
- **A reference fix:** the real fix, or a patch you wrote. It proves the task
  can be solved.
- **Pass-to-pass tests:** existing tests that pass at the base and must keep
  passing. A run passes when the hidden tests flip and nothing else breaks.

The sandbox matters as much as the tests. Clone only the ancestors of the base
commit, so the fix and every later commit are unreachable. Remove the remote.
Delete the hidden tests from the workspace and restore them only for grading.
Grade the agent's patch on a fresh copy of the base.

## Where tasks come from

- **Real bugs from history.** Walk the git log for fix commits. The base is
  the parent of the fix, and the reference is the fix. Use the fix's own tests
  if it added any; otherwise write them.
- **Bugs never fixed.** A live bug you find while mining can be a task. Write
  the reference patch yourself.
- **Traps:** tasks where the obvious fix is wrong.
  - *Fix-of-a-fix.* The first real fix was incomplete and a later commit
    finished it. Start at the first fix; the oracle must reject what it did.
  - *A plausible fix that breaks a sibling case.* In the recipe app, doubling
    a recipe also doubles "bake 40 minutes". The quick fix stops scaling every
    number in the steps, which breaks "add 200 g flour" written inside a step.
    The oracle checks both.
- **"Avoid" variants.** Start from the commit just before the bug went in,
  and give the original feature request. A pass means the feature
  works and the later fix's regression test passes.
- **Synthetic tasks** only for what history cannot give (a very long prompt).

**A good task has** one correct behaviour a careful engineer would agree on, a
symptom a user could report, tests that run offline and fast, and a fix the
agent can reach inside the time cap. Its difficulty should come from
reasoning, not step count: on a slow local model, a long task mostly measures
speed. Many good bugs have no testable seam (logic buried in UI code, code
that only runs on a hosted platform). Skipping them is right, but it means the
set leans toward code that is easy to test.

**Tiers are predictions.** Tag each task with a predicted tier (tiny, small,
medium, hard, trap) when you build it. Once several configs have run, let the
observed pass rates decide difficulty.

**Biases to write down.** *Survivorship:* a bug reaches your history only if
it got past whoever wrote and reviewed the code. If one AI tool wrote most of
it, the set leans toward that tool's blind spots and may flatter every other
model. Record who or what wrote each fix, and keep some pre-AI code as a
control. *Correlation:* three tasks on one module are not three independent
samples, and two tasks that are the same bug at two stages count as one.
*Time:* the set describes the bugs you made with a given tool; switch tools
and next month's bugs will differ.

## Writing the prompt

**Describe the symptom, never the commit.**

- Bad (a commit message): "Skip duration tokens in scaleNumbers()."
- Good (a symptom): "When I double a recipe, the cooking times double too. My
  40-minute cake now says 80 minutes. Amounts should follow the servings;
  times should not. Can you track down why and fix it?"

**End with a request** to fix it. A prompt that only describes a problem
lets a careful agent diagnose it and stop, and the stop is scored as a fail.

**Don't hand over the grep target.** Don't quote a log line or error string
that leads straight to the broken line (tolerable on the easiest tier, fatal
above it). Don't explain the cause. In one review, about a third of the
prompts gave away most of the answer.

**Name any interface the tests need.** If a hidden test calls something only
the fix creates, the prompt must name it under a plain heading such as
"Interface requirement". Otherwise no model can pass, and the task looks hard
rather than broken.

**Prompt levels.** The same bug can be written at several levels of detail:

| Level | Content | Recipe example |
|---|---|---|
| L1, pinpointed | file, function and expected behaviour | "In `scale.js`, `scaleNumbers()` multiplies every number in a step. Leave numbers followed by a time unit alone." |
| L2, symptom | what a user would report (default) | the "Good" prompt above |
| L3, vague | one line | "Doubling a recipe doubles the cooking times." |

- Each level is a **different problem,** with its own difficulty and coverage.
  Never pool levels or treat the level as a config setting: a config that ran
  the vague versions would then look weaker than one that did not. Nearly
  nine in ten vague versions turned out harder than their symptom versions.
- A vague prompt must still **pin down the graded behaviour.** "Scaled recipes
  come out wrong" does not: an agent could fix fractions instead and remove
  every symptom it was told about. Before calling a vague prompt unfair,
  check whether any model solved it from the repo alone.

**Make traps fair.** State the constraint that makes the obvious fix wrong:
"Amounts written inside the steps, like '200 g flour', must still change." A
trap tests judgement; it should not be a riddle.

**Check the repo itself.** Search the base tree's docs for the prompt's key
words; a design note that describes the fix gives the task away. A doc that
calls the behaviour intended, or deliberately postponed, makes a "fix it" task
unfair, because a careful agent follows the repo's own decision. And nothing
the agent can see (file names, extra instructions, paths) should say
"benchmark", "task" or "hidden test": it can change how the agent behaves.

## Writing the oracle

**Test the sandbox working tree.** Read source files relative to the test file
or the working directory. Never read from git, and never use an absolute path
into a source repo: an oracle that reads the reference commit instead of the
working tree passes no matter what the agent did.

**Keep tests self-contained.** The grader may append every hidden file to one
test command, so inline helpers. No side effects on the machine: no ports, no
process managers, no process kills, no network. Vendor shared test
dependencies so grading needs no network. The grader must be able to count
the tests: a file that collects nothing must show as an error, not a fail.

**Bound hangs.** If the unfixed code can loop forever, run it in a child
process with a timeout. A test framework often cannot interrupt a synchronous
loop.

**Test behaviour, not the reference fix's shape.** Each of these rejected
correct fixes in practice:

| Check | Why it fails a correct fix | Do this instead |
|---|---|---|
| exact error wording ("must contain 'cannot scale'") | the fix says "servings must be at least 1" | require a non-empty error, or test the effect |
| one output format ("1.5 cups") | the fix prints "1 1/2 cups", and the prompt never chose | accept every format the prompt allows |
| an internal name (`isDuration` must exist) | the fix named its helper differently | test through the public function |
| a literal search over the source | the fix builds the same value from a constant | run the code |
| one call shape (`scaleNumbers(text, factor)`) | the fix needs a new argument from its callers | drive it through the real callers, or name the new shape in the prompt |
| one component mounted alone | another component does the work in the fix | start the flow where a real user starts |
| an intermediate state asserted during setup | an eager fix has already changed that state | set the state up instead of asserting it |
| a hand-written request body | a stricter fix expects a different body | capture the request the patched app makes and replay that |

**Make the tests agree with the prompt.** Every graded case should follow from
the prompt or be something a competent engineer would infer from the repo. No
case may require what the prompt rules out: if the prompt says to leave the
ingredient list's layout alone, a case that wants a new column there is
unfair. If a case checks hardening the prompt never asked for, decide on
purpose: make it the trap and say so in the task notes, state it in the
prompt, or move it into a bonus test.

**Fakes and fixtures.**

- Fakes must match the real thing: the same fields, return types and starting
  state. Fakes that differed in one of these failed correct fixes.
- A fake server should allow what a correct fix might do. If it refuses every
  read, a fix that confirms its work by reading back can never pass.
- Fixtures should look like real data, in size as well as shape. A fixture far
  smaller than any real input can trip a small-sample guard in the app's own
  helpers, so a fix that reuses the helper does nothing in the test.
- Build "old" data the way old code would have. If a test makes its "old"
  recipe file by saving with the new code and then editing it, a fix that
  writes a format version into every file sees the "old" file as current.

**Positive controls for negative cases.** When a case checks that something is
refused (a stranger editing a shared recipe), first show the same request
succeeds for the rightful caller. Otherwise a fix passes by refusing
everything, or by refusing a body it does not recognise.

**Time.**

- Freeze the clock. A test that builds its data from the real clock and
  compares calendar dates can pass at noon and fail late at night. Fake only
  the date source, and leave real timers alone so async code still runs.
- Fake every clock a fix might use, or none. If the test fakes `setTimeout`
  and `Date` but not `performance.now`, a correct cooking timer built on
  `performance.now` never finishes inside the test.
- Avoid exact delays. If the prompt leaves the timing open, a test that wants
  the effect at once fails every reasonable delay. Poll for a bounded time,
  and write the bound in the task notes.

**Oracles that are too loose.** Test the outcome through real entry points. A
test that calls the new helper directly passes a fix that adds the helper and
never calls it. Make sure the weak fix the task warns about fails. Cases that
already pass at the base carry no information; record which they are.

**Stale tests in the base.** Sometimes the repo's own test asserts the buggy
behaviour ("doubling doubles every number in the steps"), and a correct fix
turns it red. Build two tasks: an easier one with the stale file removed from
the workspace, and a harder "stale tests" twin that leaves it visible, so the
agent must notice the test is wrong and update it. AI tools write many bad
tests, so this skill is worth measuring. Never pool the two. Related: if a
hidden test *replaces* a file that exists at the base, deleting it from the
workspace also deletes the agent's visible cases in that file. Put new cases
in a new file instead.

**Shared helpers and copies.** A change to a shared fake or test kit changes
every task that imports it: re-grade them all. If a test is copied into a
multi-bug task, fix every copy, and make the build step warn when copies
drift so a rebuild cannot restore an old one.

**Write down known weaknesses** in each task's notes: partial coverage, timing
waits, version dependence, and the plausible wrong fix you expect. You will
read these first when results look odd.

## Validating before any model runs

**The premise check,** for every task: the hidden tests fail at the base, pass
with the reference fix, and actually ran both times. Record which existing
tests pass at the base (the pass-to-pass set), leaving out tests that fail for
date or environment reasons.

The middle step is easy to skip, and skipping it lets unsolvable tasks in. Of
the first hundred-odd tasks in this benchmark, most built in one day, four
could not be passed by any model. They looked exactly like hard tasks.

**Check the oracle in both directions:**

- *Known-weak fixes must fail.* Write the plausible wrong fixes by hand (the
  symptom patch, the half fix, the trap) and keep them with the task.
- *A different correct design must pass.* If you can only imagine one correct
  fix, the oracle is probably pinned to it.
- *The reference minus its key rule must fail.* A cheap mutation test.
- *Coupling audit.* List the definitions the fix added and flag any the oracle
  calls that the prompt does not name. Then check call shapes for functions
  that existed at the base.

**Check the sandbox by experiment** once: in a prepared sandbox the fix commit
is unreachable, there is no remote, and the hidden tests are absent.

**Repeat anything timing-sensitive.** Run any oracle that depends on timing,
memory use or a tool version three to five times. If the premise ever flips,
retire the task or fix the cause and validate again. If dates are involved,
validate at several simulated times of day and in two far-apart time zones.

Serialise validations that touch one source repo, don't validate beside
timed benchmark runs (CPU contention skews their clocks), and delete
validation sandboxes afterwards.

**Pilots.** A new idea (a new kind of task, workflow or scoring rule) gets a
pilot of about three tasks, each run end to end as a normal attempt. Read them
before scaling up. Don't run a whole battery split by stage: eighteen
plan-only runs give eighteen half-results and no answer. A setting change on a
known-good setup (more context, a version bump, a speed flag) gets no pilot.

## Iterating on early results

The first results test your tasks as much as your models. Read them before you
trust any total.

### Read the passes

For each task, read at least two passing patches. Could a do-nothing patch or
the weak fix pass? Did the patch fix the cause, or special-case its way to
green? Do the passing cases include ones that pass at the base anyway? A check
that a wrong fix can pass is as much a defect as one that rejects a right fix.

### Read the fails

1. Collect every scored fail of the task.
2. Group them by the set of hidden cases that failed and the first assertion
   message.
3. Read at least two patches per group and give a verdict. **Genuine:** the
   change misses what the prompt asked for, or breaks something. **Artefact:**
   it does what the prompt and the reference do, and is rejected only for its
   form (wording, a literal, a file location, an unasked structure, a timing
   margin, the environment). **Unclear:** say what would settle it.
4. Read each hidden case next to the prompt.

An artefact claim needs the test file and line, which run it is, the lines
of its patch that do the right thing, and a sentence saying why the test turns
them down. Count things: "14 of 19 fails are in one group" is a finding; "most
fails" is not.

**Look hardest at** tasks where every config gets the identical partial
score, tasks nothing has passed, tasks everything passes, and tasks a strong
model fails while a weak one passes.

**A strong model's failure is not proof the task is broken.** Twice, a
frontier model's failures were read as oracle defects, and a much smaller
local model then passed both. The frontier model had written the brittle fix.
Read the transcript; never exclude a task automatically.

**For scale:** a first audit of the 50 hardest tasks read about 650 scored
fails, and about two-thirds stood as graded. The test fixes approved as one
block turned 85 fails into passes and broke no pass. Stricter checks turned 6
passes into fails.

### Fixing an oracle

A test change alters what counts as a pass, so the owner approves each one.
Then:

1. **Wait for idle.** No run may be on the task, or on any task that uses a
   shared helper you are changing.
2. **Back up** the task's files and every stored result of the task.
3. **Apply, then re-check the premise:** the base fails, the reference passes.
4. **Dry-run the re-grade over every stored result,** passes and fails. Any
   move you did not predict: restore the backup and stop.
5. **Write.** Keep each result's old score in a history field, with the
   reason and date. The task version changes; record which version graded
   each result.
6. **Regenerate the base baseline** and add a one-line note to the task.

If a stored result can't be graded again (it has no saved patch, say), keep
it if it passed, and void it if it failed under the replaced test.

### Clarifying a prompt

When the prompt was unclear rather than the test wrong: keep the passes, void
the fails, and re-run exactly the failed configs on the new prompt, held until
the new prompt is validated. Re-checking that every pass would still pass with
more guidance costs more than the noise it removes.

### Bonus tests

A bonus test rewards something a model noticed and fixed on its own.

- It checks something a careful engineer would fix along with this bug,
  ideally something a later real commit fixed (in the recipe app, oven
  temperatures were scaled too, and a later commit stopped it).
- It never contradicts the prompt, the interface or the main test. The base
  fails it and the later fix passes it; the reference may fail it.
- It is deterministic, scored as its own result with its own difficulty, and
  never changes the main verdict.
- A bonus miss means "did not notice the extra", never a prompt defect. Judge
  a prompt's fairness on the main checks only.

### Harness failures versus model failures

A run scores a model inside a harness. Decide which failures belong to which,
write the rule down, and apply it to every config alike.

| What you see | Usual cause | How to count it |
|---|---|---|
| Consecutive tasks fail in about a minute with no tool calls | dead model server | exclude; re-run |
| Cloud runs fail in about a second | expired sign-in or quota | exclude; re-run |
| The session ends on a permission prompt nobody can answer | runner permission settings differ | give every runner the same posture; exclude |
| A response stops mid-plan | a per-response output cap | remove the cap; mark the row cut off |
| The context overflows | prompt larger than the window | exclude; it depends on what the model read, so it does not cancel out |
| A tool call never returns; the run hits its cap | a tool with no timeout | harness error; exclude; add a watchdog |
| The edit tool reports success but writes the wrong indentation | a fuzzy matcher in the edit tool | counts against the config (model plus harness) |
| After compaction the agent stops and asks the user | a compaction message that invites questions | unfinished until the original prompt is sent once more |
| One block repeats over and over | a model loop | stop the agent, grade what exists; unsolved counts as a fail |
| Every run of one task ends within a second | the harness put a file outside the sandbox's view | harness error |

Use the excluded statuses honestly. Re-running an excluded row is recovery;
re-running a real fail until it passes, and keeping the pass, is
cherry-picking. A
pass exactly at the time cap is censored data; mark it. A run that ends by
asking the user is unfinished, not failed.

**Infrastructure has a signature:** several tasks in a row, each ending
after about the same short time, with no tool calls. When a model simply
can't do a task, its failures vary in length and come after real work. The
pattern only shows across rows, so read failures in batches.

A loop guard is a judgement call with a known cost. One calibration fired on
12 of about 150,000 responses, all real loops, but 3 of 15 looping runs in
that data had recovered and passed.

More cases are in the lab post "Ways my measurements lied to me".

## Maintaining the set over time

**Detector bugs.** When a status detector (overflow, provider error, killed)
misfires on clear evidence, fix it, add tests for true positives too, and
re-stamp the stored rows with the old status kept. A new *meaning* for a
status is a scoring rule and goes to the owner first.

**Record what produced each result:** the task version, the runner and its
version, the prompt level, permissions and sandbox isolation, the context
window the agent actually used, the server build and backend, and any prompt
additions. In one batch, runs labelled with a large context had used half of
it, because the agent's window setting did not match the server's. Store the
effective value and keep the two in step automatically.

**Environment rot.** Dependencies, interpreters and dates drift. Re-validate
before comparing across months; pin the environment in a container.

**Retiring tasks.** Retire a task when its premise flips under repeats, when
it cannot be made fair, or when every config scores the same on it. If later
work in the project made the tested design obsolete, write a new version that
tests the outcome. Move retired tasks aside with a one-line reason.

**Repeats.** One run per task per config is a time guideline, not a data rule;
repeats are valid data in the normal row. Pick repeats by the odds, never by
the outcome: re-running only fails moved one row by about six points. When
comparing two configs, repeat the same problems on both sides, passes and
fails alike, and wait until both sides finish before reading.

**Scoring.**

- Use difficulty-adjusted strength, not raw pass rate. Fit task difficulty and
  config strength together (a two-parameter item response model works). Rows
  run different task mixes, and a row that skipped the hardest tasks looks
  better than it is.
- Show coverage next to strength. Easy tasks barely move the estimate.
- For strong configs, run the hardest unrun tasks first. A planner that ranks
  by value per minute drifts toward short, easy tasks.
- Record per-assertion counts too. Partial credit keeps signal a bit loses.

**Uncertainty and fair comparison.**

- Binary pass/fail on about a hundred correlated tasks resolves gaps of
  roughly 20 points. At one run per task, a true 10-point gap is detected
  about 3 times in 10.
- Check your ranges against repeat data. Ours were about 1.7 times too narrow
  at first, mostly because of a shift shared by every row.
- Compare two configs by paired first attempts on shared problems, and give
  the counts where they disagree. Never compare a row's number across days.
- Compare only at equal settings: context length, harness and its version,
  prompt level, docs on or off, sampling. Any other setting is its own row.

**Tests sized to the decision.** Before queueing a check, name the decision it
feeds and the smallest measurement that settles it. Reuse old baselines
instead of re-measuring the incumbent. When a setting does not change the
score, ride along on real queued work.

**Keep your own tests away from your results.** The harness's unit tests once
wrote fake rows into the live results database. Default them to a temp one.

## Keeping it private

A private benchmark is useful only while models have not seen it.

- **No network in the agent sandbox** beyond the model endpoint. Cloud agents
  may have server-side search that a local network block cannot stop; record
  that difference.
- **Public source repos leak.** If a task's repo is public, its fix is in
  search results and maybe in training data, whatever the sandbox does. Mark
  those tasks.
- **Never publish** task ids, prompts, hidden tests or test names, fixes, task
  notes or per-task results. Public test suites get synthetic fixtures, never
  a trimmed real result or transcript.
- **Sweep before every public push:** the files and the whole history,
  including commit messages, for task ids, prompt phrases and hidden-test
  lines. Long lab notebooks are the usual culprit.

## Checklist

**Building**

- [ ] Base, prompt, hidden tests and reference fix exist.
- [ ] The prompt is a symptom, ends with a request, and has no grep target.
- [ ] Any fix-introduced interface the tests call is named in the prompt.
- [ ] Each prompt level is its own problem; traps state their constraint.
- [ ] Repo docs don't give the fix away; nothing visible says "benchmark".
- [ ] Tests read the working tree, are self-contained, and bound hangs.
- [ ] No exact wording, internal names, single formats or pinned call shapes.
- [ ] Every graded case follows from the prompt.
- [ ] Fakes match real objects; fixtures look real; negatives have controls.
- [ ] The clock is frozen, all clocks or none are faked, no exact delays.
- [ ] Stale base tests are handled; known weaknesses are in the task notes.

**Validating**

- [ ] The base fails, the reference passes, tests ran both times.
- [ ] Known-weak fixes fail, another correct design passes, coupling is clean.
- [ ] Timing and date oracles were repeated at several times and zones.
- [ ] A new idea was piloted on about three whole runs.

**Iterating**

- [ ] Two passes per task were read and deserved.
- [ ] Fails were clustered and given verdicts with evidence.
- [ ] Oracle changes: approved, backed up, dry-run, written with history.
- [ ] Clarified prompts kept passes, voided fails and re-ran them.
- [ ] Bonus results stay apart from the main verdict.
- [ ] A written rule separates harness failures from model failures.

**Maintaining**

- [ ] Detector fixes keep the old status; every result records its setup.
- [ ] Retired tasks have a one-line reason.
- [ ] Repeats are picked by the odds and are symmetric between configs.
- [ ] Comparisons use strength, coverage, paired attempts, equal settings.
- [ ] A leak sweep ran before the push.
