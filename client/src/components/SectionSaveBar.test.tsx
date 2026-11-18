import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SectionSaveBar } from "./SectionSaveBar";
import { useSectionSave } from "@/hooks/use-section-save";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

afterEach(() => {
  cleanup();
  toast.mockReset();
});

function Section({ save, initial = false }: { save: (draft: { on: boolean }) => Promise<unknown>; initial?: boolean }) {
  const [saved, setSaved] = useState({ on: initial });
  const section = useSectionSave({
    saved,
    save: async (draft) => {
      await save(draft);
      setSaved(draft);
    },
    successTitle: "Thing saved",
  });
  return (
    <div>
      <input
        type="checkbox"
        aria-label="On"
        checked={section.draft.on}
        onChange={(event) => section.update({ on: event.target.checked })}
      />
      <SectionSaveBar
        isDirty={section.isDirty}
        isSaving={section.isSaving}
        onSave={() => void section.save()}
        onReset={section.reset}
      />
    </div>
  );
}

describe("Settings section save model", () => {
  it("keeps edits as a draft until Save and marks them unsaved", async () => {
    const save = vi.fn(async () => undefined);
    render(<Section save={save} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(screen.getByLabelText("On"));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(save).toHaveBeenCalledWith({ on: true });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Thing saved" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(screen.getByLabelText("On")).toBeChecked();
  });

  it("discards the draft", () => {
    render(<Section save={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("On"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("On")).not.toBeChecked();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("raises a Save failed toast and keeps the draft when the save fails", async () => {
    render(<Section save={vi.fn(async () => Promise.reject(new Error("Server down")))} />);
    fireEvent.click(screen.getByLabelText("On"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Save failed", description: "Server down", variant: "destructive" })
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
