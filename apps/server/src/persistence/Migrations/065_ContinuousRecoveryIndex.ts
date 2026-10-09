import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_v2_continuous_recovery
    ON orchestration_v2_projection_threads(thread_id)
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.continuousRecovery') IS NOT NULL
  `;
});
