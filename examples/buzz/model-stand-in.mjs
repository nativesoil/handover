#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible Chat Completions endpoint, standing in for
 * the model inside a buzz-agent session so continuous integration can run
 * keyless. Everything else in the run is real: the buzz-agent binary, its
 * MCP subprocess handling, the soil MCP server and the store on disk.
 *
 * The script plays the model's part deterministically: when the last user
 * message says "Task: save." it answers with one soil_save tool call, when
 * it says "Task: load." with one soil_load tool call, and once a tool
 * result is in the conversation it answers with a short final line. No
 * network beyond 127.0.0.1, no keys, no model anywhere.
 *
 * Prints "LISTENING <port>" on stdout once it accepts connections; the
 * driver in acp-driver.mjs waits for that line.
 */

import { createServer } from "node:http";

/**
 * The 17 handover sections the stand-in "writes". The two locked decisions
 * carry the exact phrases the driver asserts on ("stdio-only" and
 * "no-args"), the same phrases a real model is instructed to record
 * verbatim in the claude-shim mode, so both modes are held to the same
 * assertions.
 */
const SECTIONS = {
  projectIdentity:
    "buzz-session-continuity: keep an agent session's working state loadable across buzz session resets by saving a Soil handover from inside the session.",
  decisions:
    'Locked: "Soil attaches over the stdio-only transport because buzz-agent advertises no http and no sse MCP capability." Locked: "Under buzz-acp the soil server is wrapped in a no-args script because the BUZZ_ACP_MCP_COMMAND slot passes a bare command without arguments."',
  workflow:
    "The buzz harness attaches MCP servers per session in ACP session/new; the agent calls soil_save before a session ends and a fresh session calls soil_load.",
  architecture:
    "buzz-agent spawns each configured MCP server as a stdio subprocess and namespaces its tools as server__tool; the soil server stores handovers as local files.",
  constraints:
    "The agent side speaks stdio only; every session starts cold, so anything worth keeping must be in the store before the session ends.",
  rejectedPaths:
    "Relying on the built-in context handoff summary alone was rejected for cross-session work: it is prose without structure and it stays inside the process.",
  executiveSummary:
    "One session saves structured working state through soil_save; a fresh session restores it through soil_load instead of starting from a summary.",
  currentTask:
    "Prove the save and load round trip from inside a real agent session.",
  latestUserIntent:
    "Save the working state now so the next session can pick the project back up.",
  sessionDelta:
    "This session attached the soil server in session/new and completed the save.",
  blockers: "None known at the time of the save.",
  nextSteps:
    "A fresh session loads this handover and confirms the decisions survived.",
  openQuestions:
    "Whether the harness slot should carry the wrapper script path or a resolved binary.",
  sessionActivity:
    "Configured the session MCP servers, ran the save, recorded the load code.",
  restoreInstructions:
    "Load the latest handover for buzz-session-continuity and treat the locked decisions as standing.",
  provenanceMap:
    "All facts in this handover come from the session brief and the session's own tool activity.",
  safetySummary:
    "Nothing was withheld; the session brief contains no secrets and no private paths.",
};

let toolCallCounter = 0;

function findTool(tools, suffix) {
  for (const tool of tools ?? []) {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.endsWith(suffix)) return name;
  }
  return undefined;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

function respond(res, message, finishReason) {
  const body = JSON.stringify({
    object: "chat.completion",
    model: "stand-in",
    choices: [{ index: 0, finish_reason: finishReason, message }],
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

function toolCallMessage(name, args) {
  toolCallCounter += 1;
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_stand_in_${toolCallCounter}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function handle(request, res) {
  const messages = request.messages ?? [];
  const toolResults = messages.filter((m) => m.role === "tool");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = textOf(lastUser?.content);

  if (toolResults.length > 0) {
    const resultText = textOf(toolResults[toolResults.length - 1].content);
    const code = /#\d+/.exec(resultText)?.[0];
    if (userText.includes("Task: save.")) {
      respond(
        res,
        {
          role: "assistant",
          content: `Saved. The load code is ${code ?? "unknown"}.`,
        },
        "stop",
      );
      return;
    }
    respond(
      res,
      {
        role: "assistant",
        content:
          'buzz-session-continuity: "Soil attaches over the stdio-only transport because buzz-agent advertises no http and no sse MCP capability."',
      },
      "stop",
    );
    return;
  }

  if (userText.includes("Task: save.")) {
    const name = findTool(request.tools, "__soil_save");
    if (!name) throw new Error("no soil_save tool in the request");
    respond(
      res,
      toolCallMessage(name, {
        projectId: "buzz-session-continuity",
        title: "Session state before the buzz session reset",
        sections: SECTIONS,
        source: { client: "buzz-agent", model: "stand-in" },
      }),
      "tool_calls",
    );
    return;
  }

  if (userText.includes("Task: load.")) {
    const name = findTool(request.tools, "__soil_load");
    if (!name) throw new Error("no soil_load tool in the request");
    respond(res, toolCallMessage(name, {}), "tool_calls");
    return;
  }

  throw new Error(`stand-in got a prompt it does not script: ${userText}`);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      handle(JSON.parse(Buffer.concat(chunks).toString("utf8")), res);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(`LISTENING ${server.address().port}`);
});
