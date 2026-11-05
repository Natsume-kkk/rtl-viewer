import { analyzeFileFacts } from "./facts";
import { runGeneralRules } from "./general-rules";
import { runGjb10157Rules, runGjb9765Rules } from "./gjb-rules";
import { ALL_RULE_PREFERENCES, applyRulePreferences } from "./rule-preferences";

interface FactsWorkerRequest {
  id: number;
  file: string;
  content: string;
}

self.onmessage = (event: MessageEvent<FactsWorkerRequest>) => {
  const { id, file, content } = event.data;
  try {
    const facts = analyzeFileFacts(file, content);
    const rawDiagnostics = runGeneralRules(facts, true);
    rawDiagnostics.push(...(facts.language === "vhdl" ? runGjb9765Rules(facts) : runGjb10157Rules(facts)));
    const diagnostics = applyRulePreferences(rawDiagnostics, ALL_RULE_PREFERENCES);
    self.postMessage({ id, file, fingerprint: fingerprint(content), facts, diagnostics });
  } catch (error) {
    self.postMessage({ id, file, error: error instanceof Error ? error.message : String(error) });
  }
};

function fingerprint(content: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${content.length}:${first >>> 0}:${second >>> 0}`;
}
