// services/workflowEngine.js

export class WorkflowEngine {
  constructor(workflow) {
    this.workflow = workflow;
    this.nodes = workflow.nodes;
    this.edges = workflow.edges;

    console.log("🟢 ===== WORKFLOW INITIALIZED =====");
    console.log("Workflow ID:", workflow.id);
    console.log("Total Nodes:", this.nodes.length);
    console.log("Total Edges:", this.edges.length);
    console.log("===================================");
  }

 getStartNode() {
  const startNode = this.nodes.find(n => n.is_start === true);
  console.log("🚀 Start Node Selected:", startNode?.name);
  return startNode;
}

  getNodeById(id) {
    return this.nodes.find(n => n.id === id);
  }
// 🔥 AI based routing
async getNextNodeByAI(decisionNodeId, userText, state) {

  console.log("🤖 AI deciding next node for:", userText);

  const nextNodes = this.edges
    .filter(e => e.from_node_id === decisionNodeId)
    .map(e => this.getNodeById(e.to_node_id));

  const options = nextNodes
    .map(n => `${n.id}: ${n.name}`)
    .join("\n");

  const response = await state.openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Choose the best node based on user intent.

Available nodes:
${options}

Return ONLY the node ID.`
      },
      {
        role: "user",
        content: userText
      }
    ]
  });

  const selectedId = response.choices[0].message.content.trim();

  const selectedNode = nextNodes.find(n => n.id === selectedId);

  console.log("🤖 AI selected node:", selectedNode?.name);

  return selectedNode;
}
  // 🔥 NEW: Conditional Routing
getNextNodeByCondition(currentNodeId, userText = "") {
  console.log("➡️ Finding next node from:", currentNodeId);

  const edges = this.edges.filter(
    e => e.from_node_id === currentNodeId
  );

  if (!edges.length) {
    console.warn("⚠️ No outgoing edges from:", currentNodeId);
    return null;
  }

  const lowerText = userText.toLowerCase();

  // 🔥 0️⃣ Handle DIRECT condition first


  // 1️⃣ Check keyword conditions
  for (const edge of edges) {
    const condition = edge.condition;

    if (condition?.type === "keyword") {
      const match = condition.keywords?.some(keyword =>
        lowerText.includes(keyword.toLowerCase())
      );

      if (match) {
        const node = this.getNodeById(edge.to_node_id);
        console.log("✅ Keyword match → Routing to:", node?.name);
        return node;
      }
    }
  }

  // 2️⃣ Check default condition
const defaultEdge = edges.find(
  e => e.condition?.type === "default"
);

if (defaultEdge) {
  const node = this.getNodeById(defaultEdge.to_node_id);
  console.log("➡️ Default route → Routing to:", node?.name);
  return node;
}

// 3️⃣ Finally fallback to direct
const directEdge = edges.find(
  e => e.condition?.type === "direct"
);

if (directEdge) {
  const node = this.getNodeById(directEdge.to_node_id);
  console.log("➡️ Direct fallback → Routing to:", node?.name);
  return node;
}

  console.warn("⚠️ No matching condition found");
  return null;
}



  async executeNode(node, state, exotelWs, speakText, endCall) {
    if (!node) return null;

    console.log("\n🧠 ===== WORKFLOW NODE EXECUTION =====");
    console.log("Node Name:", node.name);
    console.log("Node Type:", node.type);
    console.log("=======================================");

    switch (node.type) {



case "conversation": {

//  let userText =
//   state.fullTranscript?.slice(-1)[0]?.text || "";

// if (!userText.trim()) return null;
let userText =
  state.fullTranscript?.slice(-1)[0]?.text || "";

// ✅ If this is FIRST node (no user input yet)
// speak static prompt (greeting)
if (!userText.trim()) {
  if (node.config?.prompt) {
    console.log("🎤 Speaking initial prompt:", node.config.prompt);
    await speakText(node.config.prompt, state, exotelWs, {
      aggressive: true,
      voiceId: state.elevenLabsVoiceId,
      voice: state.sarvamVoice,
      language: state.transcriberLanguage
    });
  }

  return null;
}

console.log("🟢 ORIGINAL USER TEXT:", userText);
console.log("🌍 Detected Language:", state.transcriberLanguage);

let embeddingQuery = userText;

// 🔥 If not English → translate
if (state.transcriberLanguage !== "en") {
  console.log("🔄 Translating to English...");

  const translation = await state.openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Translate the sentence to English.

IMPORTANT RULES:
- If a word sounds like a brand, product, or English word, KEEP it in English
- Do NOT change or guess brand names
- Preserve words like Oracle, AWS, API, SQL exactly
- If unsure, keep the original word as-is
- Do NOT over-interpret meaning

Examples:
"ನನಗೆ ಹೊರಕಲ್ ಬಗ್ಗೆ ಮಾಹಿತಿ ಬೇಕು"
→ "I need information about Oracle"

"ರಾಕ್ಲ್ ಬಗ್ಗೆ ಹೇಳಿ"
→ "Tell me about Oracle"

Return ONLY the translated sentence.
`
      },
      {
        role: "user",
        content: userText
      }
    ],
    temperature: 0
  });

  embeddingQuery =
    translation.choices[0].message.content.trim();

  console.log("✅ TRANSLATED TO ENGLISH:", embeddingQuery);
} else {
  console.log("✅ English detected. No translation needed.");
}

console.log("📌 TEXT USED FOR EMBEDDING:", embeddingQuery);

  if (!userText.trim()) {
    if (node.config?.prompt) {
      await speakText(node.config.prompt, state, exotelWs, {
        aggressive: true,
        voiceId: state.elevenLabsVoiceId,
        voice: state.sarvamVoice,
        language: state.transcriberLanguage
      });
    }
    return null;
  }

  console.log("🧠 Workflow conversation mode:", node.name);

  // ✅ Prefetched KB
  const kbContext = (state.knowledgeChunks || [])
    .slice(0, 3)
    .map(c => c.content)
    .join("\n\n");

  // ✅ Restore conversation memory (VERY IMPORTANT)
  const conversationHistory =
    (state.fullTranscript || [])
      .slice(-6)
      .map(msg => ({
        role: msg.role === "bot" ? "assistant" : "user",
        content: msg.text
      }));

  // ✅ Strong production-level system prompt
  const systemPrompt = `
${state.systemPrompt || "You are a professional AI call agent."}

Knowledge:
${kbContext}

Guidelines:
- Be extremely concise (1-2 sentences max)
- Speak naturally like a human in a phone call
- Use previous conversation context
- Do not repeat questions already answered
- Ask a short clarifying question instead of guessing
- No bullet points or lists
- ALWAYS respond in the same language as the user
`.trim();

  const response = await state.openai.chat.completions.create({
    model: state.aiModel,
    temperature: state.temperature,
    messages: [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: userText }
    ]
  });

  const reply = response.choices[0].message.content;

  // Save assistant message to transcript
  state.fullTranscript.push({
    role: "bot",
    text: reply,
    timestamp: Date.now()
  });

  await speakText(reply, state, exotelWs, {
    aggressive: true,
    voiceId: state.elevenLabsVoiceId,
    voice: state.sarvamVoice,
    language: state.transcriberLanguage
  });

  return null;
}
    case "decision":
  console.log("🔀 Decision node reached");

  const userText =
    state.fullTranscript?.slice(-1)[0]?.text || "";

  const nextDecisionNode =
    await this.getNextNodeByAI(node.id, userText, state);

  console.log("🤖 AI routed to:", nextDecisionNode?.name);

  return nextDecisionNode;

     case "end_call":
  console.log("📞 Workflow reached END_CALL node");

  // 1️⃣ Speak goodbye first
await speakText(
  "Thank you for contacting Monospear. Have a great day. Goodbye.",
  state,
  exotelWs,
  {
    aggressive: true,
    voiceId: state.elevenLabsVoiceId,
    voice: state.sarvamVoice,
    language: state.transcriberLanguage
  }
);

  // 2️⃣ Small delay to allow audio to complete (optional but recommended)
  await new Promise(resolve => setTimeout(resolve, 500));

  // 3️⃣ Now end the call
  await endCall(state, exotelWs, "workflow_end");

  return null;

      default:
        console.warn("⚠️ Unknown node type:", node.type);
        return null;
    }
  }
}