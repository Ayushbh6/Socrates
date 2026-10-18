/** Conservative recognition of direct lifecycle instructions, never quoted evidence.
 * Unrecognised wording cannot authorize a status change; the UI remains available.
 */
export function taskStatusRequest(message: string): { status: 'completed' | 'open'; conditional: boolean } | null {
  if (/[`"“”\n]/u.test(message) || /\b(?:not|never|don't|do not|if|unless|might|maybe|should|would|could)\b/i.test(message)) return null;
  const clean = (s: string) => s.trim().replace(/[.!]+$/u, '').replace(/^(?:(?:hey|okay|ok|yes|please|so)[, ]+)+/i, '').replace(/,?\s+please$/i, '').trim();
  const direct = (s: string): 'completed' | 'open' | null => {
    const text = clean(s).replace(/^(?:that resolves it|that answers my question|we are done)[.!]\s*/i, '');
    if (/^(?:mark|set) (?:this|the current|my current) task (?:as )?(?:complete|completed|done)$/i.test(text) || /^close (?:this|the current|my current) task(?: now)?$/i.test(text) || /^(?:i (?:think|confirm) (?:that )?)?(?:this|the current|my current) task is (?:now )?(?:complete|completed|done)(?: now)?$/i.test(text)) return 'completed';
    if (/^(?:reopen|resume) (?:this|the current|my current) task(?: and continue)?$/i.test(text)) return 'open';
    return null;
  };
  const status = direct(message);
  if (status) return { status, conditional: false };
  const tail = clean(message).match(/^(.+?)(?:,? and then |,? then |,? and )((?:mark|set|close) .+)$/i);
  return tail && direct(tail[2]!) === 'completed' ? { status: 'completed', conditional: true } : null;
}

/** Direct requests to resume/change work in a task the human selected. Past-work
 * questions and acknowledgements deliberately do not reopen it. */
export function requestsTaskWork(message: string): boolean {
  if (taskStatusRequest(message)?.status === 'completed') return false;
  if (/[`"“”]/u.test(message)) return false;
  return /^(?:(?:please|now|okay|ok)[, ]+)*(?:reopen|resume|continue|revise|fix|update|change|add|remove|implement|build|rewrite|redo|extend|replace)\b/i.test(message.trim());
}
