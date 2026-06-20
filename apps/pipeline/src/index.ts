// apps/pipeline — queue consumer Worker (transaction processing). Built in M2.2:
// parse → transform (pinned map) → persist canonical → emit 997 (docs/04).

export interface Env {
  LATCH_DB: D1Database;
  LATCH_R2: R2Bucket;
}

export default {
  async queue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
    // M0 stub: acknowledge messages so the pipeline is wired but inert.
    for (const msg of batch.messages) {
      console.log(JSON.stringify({ msg: 'pipeline stub received', id: msg.id }));
      msg.ack();
    }
  },
};
