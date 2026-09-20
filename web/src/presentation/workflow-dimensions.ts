export const WORKFLOW_CARD_WIDTH = 208;
export const WORKFLOW_CARD_HEIGHT = 192;

export const WORKFLOW_COLUMN_GAP = 142;
export const WORKFLOW_ROW_GAP = 78;
export const WORKFLOW_RANK_GAP = 28;
export const WORKFLOW_LANE_GAP = 102;

export function workflowFallbackPosition(index: number) {
  return {
    x: (index % 3) * (WORKFLOW_CARD_WIDTH + WORKFLOW_ROW_GAP),
    y: Math.floor(index / 3) * (WORKFLOW_CARD_HEIGHT + WORKFLOW_ROW_GAP),
  };
}
