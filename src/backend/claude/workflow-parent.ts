import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { workflowInspectInput, workflowRecoverInput, workflowRelayInput, inspectDescription, recoverDescription, relayEnquiryDescription, relayPermissionDescription, type WorkflowParent } from '../workflow-tools.ts';
export function workflowParentServer(parent?: WorkflowParent) {
  if (!parent) return {};
  // The parent is woken with a request to call a specific relay tool. Newer Claude models
  // defer MCP tools behind tool search by default, which can leave that tool unavailable
  // in the relay turn. Keep these host-owned controls in the prompt from turn one.
  return { flow_workflow: createSdkMcpServer({ name: 'flow_workflow', alwaysLoad: true, tools: [
    tool('workflow_inspect', inspectDescription, workflowInspectInput.shape, async input => ({ content: [{ type: 'text', text: JSON.stringify(await parent.inspect(input)) }] })),
    tool('workflow_recover', recoverDescription, workflowRecoverInput.shape, async (input, extra) => ({ content: [{ type: 'text', text: JSON.stringify(await parent.recover(input, (extra as { signal?: AbortSignal } | undefined)?.signal)) }] })),
    tool('workflow_relay_enquiry', relayEnquiryDescription, workflowRelayInput.shape, async (input, extra) => ({ content: [{ type: 'text', text: JSON.stringify(await parent.relayEnquiry(input, (extra as { signal?: AbortSignal } | undefined)?.signal)) }] })),
    tool('workflow_relay_permission', relayPermissionDescription, workflowRelayInput.shape, async (input, extra) => ({ content: [{ type: 'text', text: JSON.stringify(await parent.relayPermission(input, (extra as { signal?: AbortSignal } | undefined)?.signal)) }] })),
  ] }) };
}
