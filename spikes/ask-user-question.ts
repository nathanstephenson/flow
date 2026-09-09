/**
 * Manual probe: find out whether Flow can serve the SDK's `AskUserQuestion` tool at all.
 *
 * The Claude adapter denies every tool outside its allowlist, so a model that asks its human a
 * question today is told the tool is unavailable. Serving one means holding `canUseTool` open until
 * a human answers — the first time this harness blocks a turn on a person — and everything about
 * that design rests on facts only a live run can supply.
 *
 * The static half is already answered, by `spikes/probe-type.ts` rather than by guessing:
 *
 *     … 'Parameters<NonNullable<claude.Options["canUseTool"]>>[2]'
 *         → signal, suggestions?, blockedPath?, decisionReason?, title?, displayName?,
 *           description?, toolUseID: string, agentID?: string, requestId: string, matchedAskRule?
 *     … '{ a: …[0]; b: …[1] }'   → a: string, b: Record<string, unknown>
 *     … 'claude.PermissionResult'
 *         → allow  { updatedInput?: Record<string, unknown>, updatedPermissions?, toolUseID?, … }
 *           deny   { message: string, interrupt?: boolean, toolUseID?, … }
 *
 * **`toolUseID` is required on the options bag**, which is the one that mattered: an Enquiry can be
 * keyed by the tool call that asked it, so it needs no id space of its own — the rule ADR 0015 sets
 * for a Subagent. There is no `AskUserQuestionInput` export and no `ToolInput` union, so the input
 * is `Record<string, unknown>` and every field has to be narrowed rather than trusted.
 *
 * What is left is behaviour, and this is what this probe is for:
 *
 *   1. **Does `canUseTool` fire for `AskUserQuestion` at all?** Existential. The CLI may handle this
 *      tool itself and never surface it, or not offer it in streaming-input mode. If it never fires,
 *      the tool is not servable by this backend and the feature stops.
 *   2. Does the `toolUseID` equal the `id` of the `tool_use` block on the assistant message?
 *   3. Which of the two arrives first — the assistant message, or the callback?
 *   4. What does `{behavior:"allow", updatedInput:{...input, answers}}` produce downstream, and what
 *      does the `tool_result` look like once it comes back?
 *   5. How are a multiSelect answer and a free-text answer encoded inside `answers`?
 *   6. Does `{behavior:"deny"}` leave the conversation well-formed enough to `--resume`? This is what
 *      makes abandoning an unanswered Enquiry on shutdown safe, and it is the one failure that would
 *      otherwise surface a turn after a Revive, in production.
 *   7. What is actually in `preview`?
 *
 *     node --experimental-strip-types spikes/ask-user-question.ts            # answer it
 *     node --experimental-strip-types spikes/ask-user-question.ts --deny     # abandon it (item 6)
 *
 * Everything is logged whole — `JSON.stringify` of the entire input and the entire options bag —
 * rather than the fields we expect to find, because the point of a probe is the fields we did not.
 *
 * ## What it answered, 2026-09
 *
 * **It is servable.** `canUseTool` fires for `AskUserQuestion` in streaming-input mode, with the tool
 * left out of `allowedTools`, on subscription credentials. Item 1 passes and the feature is real.
 *
 * **The assistant message arrives first, by about four milliseconds**, and its `tool_use` block's id
 * is the `toolUseID` on the options bag — the same value, every run:
 *
 *     +6325ms  assistant  tool_use AskUserQuestion id=toolu_01BMwrUGnwL193kbRoeMYjcK
 *     +6329ms  canUseTool  AskUserQuestion   toolUseID=toolu_01BMwrUGnwL193kbRoeMYjcK
 *
 * So an Enquiry is keyed by the call that asked it and needs no id space of its own, and the `tool`
 * Entry for that call already exists in the transcript by the time the Enquiry does. Items 2 and 3,
 * and the fallback correlation they were going to force, is not needed.
 *
 * **`answers` is keyed by question text, and takes a string or an array of them.** Both were
 * accepted; the CLI comma-joins the array when it writes the result:
 *
 *     answers {"Which validation library…?": "Neither — something I typed myself",
 *              "Which cross-cutting features…?": ["Caching","Retries"]}
 *
 * A free-text answer is just a string in the same slot — no marker, no separate field, and the CLI
 * echoes it verbatim. There is nothing to add for the "Other" case: it is an answer like any other.
 *
 * **The `tool_result` is prose, not data**, and this is the finding that changed the design:
 *
 *     "The user answered: \"Which validation library…?\"=\"zod\",
 *      \"Which cross-cutting features…?\"=\"Caching,Retries\". Read the answers carefully — …"
 *
 * The structure is gone by the time it comes back. A front-end that rendered an answered Enquiry
 * from the `tool_ended` alone would be parsing an English sentence to find out what its own user
 * clicked — which is why what was chosen is carried on the Enquiry's own snapshot instead, and why
 * that snapshot is a real event rather than something derived from the tool call around it.
 *
 * **Denial is clean.** `{behavior:"deny", message}` produces a well-formed `tool_result` carrying the
 * message and `is_error: true`, against the right `tool_use_id`, and the turn then ends normally:
 *
 *     tool_result {"content":"The human did not answer, …","is_error":true,"tool_use_id":"toolu_…"}
 *
 * So abandoning an unanswered Enquiry by *denying* it — rather than by tearing the process down
 * around it — leaves the conversation record complete, and a later Revive resumes onto a turn with no
 * dangling `tool_use`. That is what makes the shutdown path in the adapter safe, and it is the reason
 * every abandonment settles the callback rather than dropping it.
 *
 * **The Revive question is settled too, and by more than this probe.** Denying is what the adapter
 * does on every teardown path, and an Agent Session torn down mid-Enquiry was afterwards Revived and
 * took an ordinary turn with no notice and no error — so the denial really does leave the record
 * complete. That was the one failure that would otherwise have surfaced only in production, a turn
 * after a Revive.
 *
 * **Two things this did not answer.** No `preview` was ever emitted — the model populated `label` and
 * `description` and nothing else across every run — so its shape is still unknown and nothing should
 * render it yet. And `agentID` stayed absent, because nothing here ran inside a Subagent; whether a
 * Subagent's Enquiry is attributable is still open, which is why `producer` is carried but is only
 * populated where the SDK supplies it.
 */
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const deny = process.argv.includes("--deny");

/**
 * Two questions, one of each kind, so item 5 is answered in a single run: a single-select whose
 * answer is a listed label, and a multiSelect answered with two of them. The prompt names the tool
 * outright because a model left to decide would usually just ask in prose, and a probe that depends
 * on the model choosing to call a tool measures the model rather than the harness.
 */
const PROMPT = [
  "Use the AskUserQuestion tool, right now, to ask me two things at once:",
  "(1) whether this parser rewrite should use zod or valibot — a single choice;",
  "(2) which of caching, retries and logging to include — several allowed, so set multiSelect.",
  "Give every option a description. Do not ask in prose; use the tool.",
].join(" ");

const start = Date.now();
const at = (): string => `+${String(Date.now() - start).padStart(5)}ms`;

const one = async function* (): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: PROMPT },
  } as SDKUserMessage;
};

const options: Options = {
  cwd: process.cwd(),
  // "default" and not "bypassPermissions", for the reason the adapter documents: bypass auto-approves
  // before canUseTool is consulted. And AskUserQuestion is deliberately NOT in allowedTools — an
  // allowlisted tool skips the callback entirely, which is the whole mechanism under test.
  permissionMode: "default",
  allowedTools: [],
  canUseTool: async (toolName, input, extra) => {
    if (toolName === "AskUserQuestion") sawCallback = true;
    console.log(`\n${at()}  canUseTool  ${toolName}`);
    console.log(`    input   ${JSON.stringify(input)}`);
    console.log(`    extra   ${JSON.stringify(extra, replacer)}`);

    if (toolName !== "AskUserQuestion") {
      return { behavior: "deny" as const, message: `${toolName} is not enabled for this probe.` };
    }
    if (deny) {
      // Item 6. The message is written for the model, in the register the adapter already uses for a
      // tool it will not run — a denial it can read and carry on from.
      return {
        behavior: "deny" as const,
        message: "The human did not answer, and this session is no longer waiting. Continue without it.",
      };
    }

    // Item 5: answer the first question with a listed label, and the second with two of them, so the
    // encoding of a multiSelect answer is visible in the tool_result rather than assumed. `answers`
    // is keyed by question text, which is itself a thing to confirm rather than to trust.
    const answers = answersFor(input);
    console.log(`    answers ${JSON.stringify(answers)}`);
    return { behavior: "allow" as const, updatedInput: { ...input, answers } };
  },
};

console.log(deny ? "denying the question (item 6)\n" : "answering the question\n");

const stream = query({ prompt: one(), options });
const timeout = setTimeout(() => {
  console.log("\ntimed out after 120s");
  console.log("→ If no canUseTool line appeared above, item 1 failed: the CLI never surfaced the tool.");
  process.exit(1);
}, 120_000);

let sawCallback = false;
for await (const message of messages(stream)) describe(message);
clearTimeout(timeout);

if (!sawCallback) {
  console.log("\n→ ITEM 1 FAILED. canUseTool never fired for AskUserQuestion, so this backend cannot serve one.");
}

async function* messages(source: AsyncIterable<SDKMessage>): AsyncGenerator<SDKMessage> {
  try {
    for await (const message of source) yield message;
  } catch (error) {
    console.log(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The whole of each message that bears on the ordering question, and a one-liner for the rest. */
function describe(message: SDKMessage): void {
  const subtype = "subtype" in message ? `/${message.subtype}` : "";
  const head = `${at()}  ${message.type}${subtype}`;

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        // Item 2 and item 3 both read off this line: the id to compare against `toolUseID`, and the
        // position of this line relative to the `canUseTool` one above it.
        console.log(`${head}  tool_use ${block.name} id=${block.id}`);
        console.log(`    input ${JSON.stringify(block.input)}`);
      }
    }
    return;
  }

  if (message.type === "user") {
    // Item 4. The tool_result is what the model actually reads back, and what the adapter will
    // re-emit as `tool_ended` — so its shape decides what a transcript row can say.
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block && "type" in block && block.type === "tool_result") {
          console.log(`${head}  tool_result ${JSON.stringify(block)}`);
        }
      }
    }
    return;
  }

  if (message.type === "result") {
    const usage = "usage" in message ? message.usage : undefined;
    console.log(`${head}  turns=${message.num_turns} input_tokens=${usage?.input_tokens ?? 0}`);
    return;
  }

  console.log(head);
}

/**
 * Pick an answer for every question the tool posed: the first option for a single-select, the first
 * two for a multiSelect, and — for the last question, whatever it is — a string that appears in no
 * option at all, which is how the free-text case gets probed without a second run.
 *
 * Lenient throughout. The input is `Record<string, unknown>` with no type to lean on, and a probe
 * that throws on a shape the CLI produced tells us nothing about the shape it produced.
 */
function answersFor(input: Record<string, unknown>): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, unknown> = {};

  questions.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const question = raw as Record<string, unknown>;
    const text = typeof question.question === "string" ? question.question : `question-${index}`;
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = options
      .map((option) => (option && typeof option === "object" ? (option as Record<string, unknown>).label : undefined))
      .filter((label): label is string => typeof label === "string");

    console.log(`    q${index} multiSelect=${String(question.multiSelect)} options=${JSON.stringify(options)}`);

    if (index === 0) {
      // The free-text case: a human who agreed with none of the offered labels. Sent as a bare
      // string in the same slot, because that is the shape the harness would have to send.
      answers[text] = "Neither — something I typed myself";
      return;
    }
    // A multiSelect answered with two labels. Sent as an array, which is the shape with no
    // documentation behind it and so the one this probe exists to settle.
    answers[text] = question.multiSelect === true ? labels.slice(0, 2) : (labels[0] ?? "");
  });

  return answers;
}

/** An AbortSignal does not survive JSON.stringify, and its presence is all the probe needs. */
function replacer(key: string, value: unknown): unknown {
  return value instanceof AbortSignal ? `[AbortSignal aborted=${value.aborted}]` : value;
}
