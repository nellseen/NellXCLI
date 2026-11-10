import { describe, expect, it } from "vitest";
import { filterSelectionOptions } from "../src/tui.js";
import { filterSelectOptions } from "../src/tui-select.js";

describe("chat selection filtering", () => {
  it("matches both display names and canonical IDs case-insensitively", () => {
    const options = [
      { label: "Gemini 3.5 Flash", detail: "gemini-3.5-flash", value: "flash" },
      { label: "Gemini 3.5 Pro", detail: "gemini-3.5-pro", value: "pro" },
      { label: "Gemini 2.5 Flash", detail: "gemini-2.5-flash", value: "old" },
    ];

    expect(filterSelectionOptions(options, "GEMINI-3.5")).toEqual(
      options.slice(0, 2),
    );
    expect(filterSelectionOptions(options, "pro")).toEqual([options[1]]);
  });

  it("returns the complete list for a blank query and none for no matches", () => {
    const options = [{ label: "Gemini Flash", value: "flash" }];
    expect(filterSelectionOptions(options, "   ")).toEqual(options);
    expect(filterSelectionOptions(options, "does-not-exist")).toEqual([]);
  });
});

describe("shared TUI selector filtering", () => {
  it("filters setup models by display name and model ID", () => {
    const options = [
      { label: "Gemini Flash", detail: "gemini-3-flash", value: "flash" },
      { label: "Gemini Pro", detail: "gemini-3-pro", value: "pro" },
    ];

    expect(filterSelectOptions(options, "GEMINI-3-FLASH")).toEqual([
      options[0],
    ]);
    expect(filterSelectOptions(options, "pro")).toEqual([options[1]]);
  });

  it("returns no options for a filter without matches", () => {
    expect(
      filterSelectOptions([{ label: "Gemini Flash", value: "flash" }], "xyz"),
    ).toEqual([]);
  });
});
