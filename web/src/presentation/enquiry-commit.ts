/**
 * Submit an Enquiry answer only while its request still owns the composer.
 *
 * The command response can arrive after a terminal event, or after the next relayed Enquiry. Callers
 * must not commit local answer state in either case.
 */
export async function answerCurrentEnquiry(
  askId: string,
  answers: string[][],
  answer: (askId: string, answers: string[][]) => Promise<boolean>,
  currentAskId: () => string | undefined,
): Promise<boolean> {
  const accepted = await answer(askId, answers);
  return accepted && currentAskId() === askId;
}
