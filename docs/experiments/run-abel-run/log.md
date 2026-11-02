# Experiment log: "Run, Abel, Run!"

A record of the experiment, written while it runs, for the final report.
The game is a 2D endless runner: Abel (a dog) runs right on his own, the
player only jumps over obstacles, bones give points and the game keeps
getting faster.

Team: PO, Developer and QA, all AI-powered (Claude Code, Claude Pro plan).

## Plan

| Step | Request | What it tests |
| --- | --- | --- |
| 1 | Vague first request; some answers clear, some "you decide", speed "harder but fair" | How the PO asks, what it decides on its own |
| 2 | 🐞 Bug: obstacles that cannot be jumped | Bug origin: requirements or code |
| 3 | Golden bone that appears "rarely" | Whether the PO turns a vague word into a testable rule |
| 4 | 3 lives (in conflict with earlier rules) | Whether the PO spots the conflict |
| 5 | Abel's look (not testable) | How QA handles a request it cannot verify |
| 6 | Final bug | The whole loop once more |

## Step 1: first request

To fill in: the request, the PO's 6 questions (asked in one message, so
recorded as 1 interruption and 6 questions), the answers, the assumptions
and the outcome.

## Step 2: bug report

To fill in.

## Step 3: golden bone

**Request (change request):** "Add a golden bone worth 5 points that appears rarely."

**PO reply (AI-powered, 11:24:56):** it stopped once and asked 5 questions in
one message, before updating the requirements. Screenshot:
[step3-po-questions.png](step3-po-questions.png).

> Before I update the requirements, I need to pin down a few details of the golden bone.

1. **What does "appears rarely" mean in numbers?**
   Options: about 1 in 10 spawned bones is golden (10% chance) / about 1 in 20
   (5% chance) / at most one golden bone every ~30 seconds of play / you decide.
   *Why it matters:* the Developer needs a testable frequency, and "rarely"
   can mean very different things.
2. **How should the golden bone look?**
   Options: same bone shape as the white bones, coloured gold (#ffd700) / same
   shape, gold and slightly larger than white bones / you decide.
   *Why it matters:* the look has to be unambiguous so players can tell it
   apart from normal white bones.
3. **Should the golden bone follow the same placement rules as normal bones
   (80 px boneGap from obstacles, reachable with the fixed jump, collectable
   in the same jump that clears a nearby obstacle)?**
   Options: yes, exactly the same rules / no, it may be placed differently
   (please describe).
   *Why it matters:* this decides whether the existing placement rules also
   apply to the new bone, or whether it needs special treatment (e.g. placed
   higher).
4. **Should anything extra happen when the golden bone is collected, beyond
   adding 5 points to the score?**
   Options: no, only +5 points / show a short "+5" text where it was
   collected / you decide.
   *Why it matters:* without extra feedback (e.g. a "+5" text) the collect
   looks identical to a normal bone, and the PO should not add things the
   user did not ask for.
5. **Should the golden bone appear only after the game has been running for
   some time, or can it appear from the start of play?**
   Options: it can appear from the start / only after a set time (please
   give seconds) / you decide.
   *Why it matters:* this affects whether there is a start delay in the
   spawn logic.

**First observations:**
- The PO did not accept "rarely" as it was: question 1 asks for a number and
  gives the reason ("the Developer needs a testable frequency"). This is the
  behaviour Step 3 was meant to test.
- It reused the rules agreed in earlier versions (80 px boneGap, fixed jump)
  instead of starting over (question 3).
- It explicitly avoided adding features nobody asked for (question 4).
- Every question offers "you decide" except question 3, where the choice
  changes existing rules.

**Answers, assumptions and outcome:** to fill in.

## Step 4: three lives

To fill in.

## Step 5: Abel's look

To fill in.

## Step 6: final bug

To fill in.
