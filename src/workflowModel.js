import db from "../db.js";

async function getWorkflowByAgentId(agentId) {
  try {
    // 1️⃣ Get workflow
    const workflowResult = await db.query(
      `SELECT * FROM workflows 
       WHERE agent_id = $1 AND is_active = true
       LIMIT 1`,
      [agentId]
    );

    if (!workflowResult.rows.length) {
      console.log("⚠️ No workflow found for agent:", agentId);
      return null;
    }

    const workflow = workflowResult.rows[0];

    // 2️⃣ Get nodes
    const nodesResult = await db.query(
      `SELECT * FROM workflow_nodes 
       WHERE workflow_id = $1`,
      [workflow.id]
    );

    // 3️⃣ Get edges
    const edgesResult = await db.query(
      `SELECT * FROM workflow_edges 
       WHERE workflow_id = $1`,
      [workflow.id]
    );

    return {
      id: workflow.id,
      nodes: nodesResult.rows,
      edges: edgesResult.rows
    };

  } catch (error) {
    console.error("❌ Error loading workflow:", error.message);
    return null;
  }
}

export default {
  getWorkflowByAgentId
};