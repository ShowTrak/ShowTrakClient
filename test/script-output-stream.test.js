const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/Modules/ScriptManager/output-stream.ts: how a running script's
// console is batched for the server's console view. What matters: output
// arrives in order and complete (nothing lost at the end of a run), a chatty
// script cannot flood the socket, and a runaway one stops being sent at the
// cap with the server told why.

const { CreateOutputStreamer, MAX_CHUNK_CHARS } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'output-stream.js')
);

function recorder() {
  const Sent = [];
  return { Sent, Send: (Chunks, Truncated) => Sent.push({ Chunks, Truncated }) };
}

test('writes are batched, merging runs of the same stream in order', () => {
  const { Sent, Send } = recorder();
  const S = CreateOutputStreamer(Send, { FlushMs: 10_000 });
  S.Write('stdout', 'a');
  S.Write('stdout', 'b');
  S.Write('stderr', 'oops');
  S.Write('stdout', 'c');
  assert.equal(Sent.length, 0, 'nothing is sent before the batch is flushed');
  S.Close();
  assert.deepEqual(Sent, [
    {
      Chunks: [
        { Stream: 'stdout', Text: 'ab' },
        { Stream: 'stderr', Text: 'oops' },
        { Stream: 'stdout', Text: 'c' },
      ],
      Truncated: false,
    },
  ]);
});

test('the batch is sent on its timer', async () => {
  const { Sent, Send } = recorder();
  const S = CreateOutputStreamer(Send, { FlushMs: 5 });
  S.Write('stdout', 'tick');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(Sent.length, 1);
  S.Close();
  assert.equal(Sent.length, 1, 'closing with nothing pending sends nothing');
});

test('long text is split to the server chunk limit', () => {
  const { Sent, Send } = recorder();
  const S = CreateOutputStreamer(Send, { FlushMs: 10_000 });
  S.Write('stdout', 'x'.repeat(MAX_CHUNK_CHARS + 5));
  S.Close();
  const Lengths = Sent.flatMap((B) => B.Chunks.map((C) => C.Text.length));
  assert.deepEqual(Lengths, [MAX_CHUNK_CHARS, 5]);
});

test('output past the per-run cap is not sent, and the server is told', () => {
  const { Sent, Send } = recorder();
  const S = CreateOutputStreamer(Send, { FlushMs: 10_000, MaxRunChars: 10 });
  S.Write('stdout', '12345');
  S.Write('stdout', '67890ABC');
  S.Write('stdout', 'never sent');
  S.Close();
  const Text = Sent.flatMap((B) => B.Chunks.map((C) => C.Text)).join('');
  assert.equal(Text, '1234567890');
  assert.equal(Sent.filter((B) => B.Truncated).length, 1);
});

test('nothing is written after close', () => {
  const { Sent, Send } = recorder();
  const S = CreateOutputStreamer(Send, { FlushMs: 10_000 });
  S.Close();
  S.Write('stdout', 'late');
  S.Flush();
  assert.deepEqual(Sent, []);
});
