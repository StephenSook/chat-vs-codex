import { defineConfig } from "vite";
import { buildJudgeEvidence } from "../../scripts/judge-evidence.js";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "judge-committed-evidence",
      async generateBundle() {
        const { files } = await buildJudgeEvidence();
        for (const [fileName, source] of files)
          this.emitFile({ type: "asset", fileName, source });
      },
    },
  ],
});
