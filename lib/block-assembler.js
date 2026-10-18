/**
 * Minimal response-stream assembler used by the reviewer.
 *
 * The host's dsh-llm package is bundled inside the desktop app and is not a
 * dependency available to profile-linked plugins. The reviewer only needs this
 * small text-delta contract, so keeping it local makes the plugin importable in
 * both desktop and CLI profiles without reaching into app.asar internals.
 */
export class BlockAssembler {
  constructor() {
    this.list = []
  }

  push(chunk) {
    if (chunk?.type !== 'text-delta') return
    const last = this.list.at(-1)
    if (last?.type === 'text') last.text += chunk.text ?? ''
    else this.list.push({ type: 'text', text: chunk.text ?? '' })
  }

  blocks() {
    return this.list
  }
}
