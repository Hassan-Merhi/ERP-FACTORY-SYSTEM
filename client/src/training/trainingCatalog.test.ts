import { describe, expect, it } from "vitest";
import { TRAINING_TOPICS, visibleTrainingTopics } from "./trainingCatalog";

describe("training library permissions", () => {
  it("shows getting started but not restricted guides for an unprivileged viewer", () => {
    const topics = visibleTrainingTopics("factory", "Worker", [], false);
    expect(topics.map((topic) => topic.id)).toEqual(["welcome"]);
  });
  it("shows only specifically permitted factory guides", () => {
    const topics = visibleTrainingTopics("factory", "Worker", ["factory/stock-entry"], false);
    expect(topics.map((topic) => topic.id)).toEqual(["welcome", "factory-stock-entry"]);
    expect(topics.some((topic) => topic.id === "factory-accounts")).toBe(false);
  });
  it("does not mix ERP and Factory module guides", () => {
    const topics = visibleTrainingTopics("erp", "Admin", undefined, false);
    expect(topics.every((topic) => topic.mode === "erp" || topic.mode === "both")).toBe(true);
    expect(topics.some((topic) => topic.id === "factory-containers")).toBe(false);
  });
  it("uses unique IDs and targets allowed route families", () => {
    expect(new Set(TRAINING_TOPICS.map((topic) => topic.id)).size).toBe(TRAINING_TOPICS.length);
    for (const topic of TRAINING_TOPICS) {
      if (!topic.route) continue;
      expect(topic.route.startsWith(topic.mode === "factory" ? "/factory/" : "/")).toBe(true);
    }
  });
});
