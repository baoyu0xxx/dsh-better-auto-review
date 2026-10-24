/**
 * Minimal response-stream assembler used by the reviewer.
 *
 * The host's dsh-llm package is bundled inside the desktop app and is not a
 * dependency available to profile-linked plugins. The reviewer only needs this
 * small text/reasoning-delta contract, so keeping it local makes the plugin
 * importable in both desktop and CLI profiles without reaching into app.asar
 * internals.
 *
 * Reasoning deltas are kept as their own blocks on purpose: {@link readDecision}
 * treats "some reasoning blocks, then exactly one text block" as the only valid
 * shape, so dropping reasoning here would make that check vacuous.
 */
export class BlockAssembler {
  constructor() {
    this.list = []
  }

  push(chunk) {
    if (chunk?.type === 'text-delta') append(this.list, 'text', chunk.text)
    else if (chunk?.type === 'reasoning-delta') append(this.list, 'reasoning', chunk.text)
  }

  blocks() {
    return this.list
  }
}

/** Append one delta, merging it into the previous block of the same kind. */
function append(list, type, text) {
  const value = text ?? ''
  const last = list.at(-1)
  if (last?.type === type) last.text += value
  else list.push({ type, text: value })
}
