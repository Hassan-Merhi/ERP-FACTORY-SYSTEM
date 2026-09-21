import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

interface ProductTranslation {
  id: number;
  articleCode?: string | null;
  nameAr?: string | null;
  descriptionAr?: string | null;
}

function findEditDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((dialog) =>
    Array.from(dialog.querySelectorAll("h1,h2,h3,[data-radix-dialog-title]")).some(
      (heading) => heading.textContent?.trim() === "Edit Product"
    )
  ) ?? null;
}

function findArticleCode(dialog: HTMLElement): string {
  const label = Array.from(dialog.querySelectorAll<HTMLLabelElement>("label")).find((item) =>
    item.textContent?.trim().startsWith("Article Code")
  );
  const labelledInput = label?.htmlFor ? dialog.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`) : null;
  if (labelledInput) return labelledInput.value.trim();
  const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input:not([dir="rtl"])'));
  return inputs[1]?.value.trim() ?? "";
}

function findSaveButton(dialog: HTMLElement): HTMLButtonElement | null {
  return Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((button) => {
    const text = button.textContent?.trim().toLowerCase() ?? "";
    return !button.disabled && (text.includes("save") || text.includes("update product"));
  }) ?? null;
}

export function BaleProductArabicEditBridge() {
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [nameAr, setNameAr] = useState("");
  const [descriptionAr, setDescriptionAr] = useState("");
  const nameArRef = useRef("");
  const descriptionArRef = useRef("");
  const productIdRef = useRef<number | null>(null);
  const bypassRef = useRef(false);
  const savingRef = useRef(false);
  const productsRef = useRef<ProductTranslation[]>([]);
  const hydratedKeyRef = useRef<string | null>(null);
  const refetchedKeyRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const { toast } = useToast();

  const loadProducts = async () => {
    const response = await fetch("/api/factory/bale-products?lang=en", { credentials: "include" });
    productsRef.current = response.ok ? await response.json() : productsRef.current;
  };

  useEffect(() => {
    nameArRef.current = nameAr;
  }, [nameAr]);
  useEffect(() => {
    descriptionArRef.current = descriptionAr;
  }, [descriptionAr]);
  useEffect(() => {
    productIdRef.current = productId;
  }, [productId]);

  useEffect(() => {
    void loadProducts().catch(() => undefined);
  }, []);

  useEffect(() => {
    const sync = () => {
      const nextDialog = findEditDialog();
      if (!nextDialog) {
        setDialog(null);
        setMountNode(null);
        setProductId(null);
        hydratedKeyRef.current = null;
        refetchedKeyRef.current = null;
        dirtyRef.current = false;
        return;
      }

      let target = nextDialog.querySelector<HTMLElement>("[data-bilingual-pencil-fields]");
      if (!target) {
        target = document.createElement("div");
        target.dataset.bilingualPencilFields = "true";
        const footer = Array.from(nextDialog.querySelectorAll<HTMLElement>("div")).find((element) =>
          element.className.includes("justify-end") && element.querySelector("button")
        );
        if (footer?.parentElement) footer.parentElement.insertBefore(target, footer);
        else nextDialog.appendChild(target);
      }

      const articleCode = findArticleCode(nextDialog).toUpperCase();
      const product = productsRef.current.find(
        (item) => (item.articleCode ?? "").trim().toUpperCase() === articleCode
      );
      setDialog(nextDialog);
      setMountNode(target);
      setProductId(product?.id ?? null);

      // The cached catalog can predate this product (e.g. it was just created), so
      // refetch once per unresolved article code instead of leaving the fields inert.
      if (!product && articleCode && refetchedKeyRef.current !== articleCode) {
        refetchedKeyRef.current = articleCode;
        void loadProducts().catch(() => undefined);
      }

      // Only seed the Arabic fields when we switch to a different product, and never
      // once the user has started typing — this loop reruns every 300ms and on every
      // DOM mutation, so unconditional seeding wipes input as it is entered.
      if (dirtyRef.current) return;
      if (hydratedKeyRef.current === articleCode && product) return;

      hydratedKeyRef.current = product ? articleCode : null;
      setNameAr(product?.nameAr ?? "");
      setDescriptionAr(product?.descriptionAr ?? "");
    };

    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        sync();
      });
    };

    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const captureSave = async (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest("button") as HTMLButtonElement | null;
      if (!button || button !== findSaveButton(dialog)) return;
      if (bypassRef.current) {
        bypassRef.current = false;
        return;
      }
      if (savingRef.current || !productIdRef.current) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      savingRef.current = true;
      try {
        const response = await fetch(`/api/factory/bale-products/${productIdRef.current}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nameAr: nameArRef.current.trim() || null,
            descriptionAr: descriptionArRef.current.trim() || null,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || "Unable to update Arabic translation");
        await queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
        await loadProducts().catch(() => undefined);
        dirtyRef.current = false;
        hydratedKeyRef.current = null;
        bypassRef.current = true;
        button.click();
      } catch (error) {
        toast({
          title: "Arabic translation update failed",
          description: error instanceof Error ? error.message : "Unable to save Arabic fields",
          variant: "destructive",
        });
      } finally {
        savingRef.current = false;
      }
    };
    document.addEventListener("click", captureSave, true);
    return () => document.removeEventListener("click", captureSave, true);
  }, [dialog, toast]);

  if (!mountNode) return null;
  return createPortal(
    <div className="grid gap-4 border-t pt-4 mt-4" dir="ltr">
      <div className="grid gap-2">
        <Label htmlFor="edit-product-name-ar">Product Name — Arabic</Label>
        <Input
          id="edit-product-name-ar"
          dir="rtl"
          value={nameAr}
          onChange={(event) => {
            dirtyRef.current = true;
            setNameAr(event.target.value);
          }}
          placeholder="اسم المنتج بالعربية"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-product-description-ar">Description — Arabic</Label>
        <Textarea
          id="edit-product-description-ar"
          dir="rtl"
          value={descriptionAr}
          onChange={(event) => {
            dirtyRef.current = true;
            setDescriptionAr(event.target.value);
          }}
          placeholder="وصف المنتج بالعربية"
        />
      </div>
    </div>,
    mountNode
  );
}
