import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Upload, Trash2, ImagePlus, Search, Images, ChevronLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { FactoryBaleProductImage } from "@shared/schema";
import { PageHeader } from "@/components/PageHeader";
import { productMatchesSearch } from "@shared/factoryProductSearch";

interface BaleProduct {
  id: number;
  code: string;
  articleCode: string;
  name: string;
  nameAr?: string | null;
  categoryId?: number;
  active?: boolean;
}

export default function BaleProductImages() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<BaleProduct | null>(null);
  const [showList, setShowList] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const productsQuery = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });

  const imagesQueryKey = selectedProduct
    ? `/api/factory/bale-product-images?articleCode=${encodeURIComponent(selectedProduct.articleCode)}`
    : null;

  const imagesQuery = useQuery<FactoryBaleProductImage[]>({
    queryKey: [imagesQueryKey],
    enabled: !!imagesQueryKey,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedProduct) throw new Error("No product selected");
      const formData = new FormData();
      formData.append("image", file);
      formData.append("articleCode", selectedProduct.articleCode);
      formData.append("productId", String(selectedProduct.id));
      const res = await fetch("/api/factory/bale-product-images", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      if (imagesQueryKey) queryClient.invalidateQueries({ queryKey: [imagesQueryKey] });
      toast({ title: "Image uploaded" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/factory/bale-product-images/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      if (imagesQueryKey) queryClient.invalidateQueries({ queryKey: [imagesQueryKey] });
      toast({ title: "Image deleted" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      Array.from(files).forEach((f) => {
        if (f.type.startsWith("image/")) uploadMutation.mutate(f);
      });
    },
    [uploadMutation]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const filteredProducts = (productsQuery.data ?? []).filter((p) => productMatchesSearch(p, search));

  const images = imagesQuery.data ?? [];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row" data-testid="bale-product-images-page">
      {/* ── Left: Product List ─────────────────────────────────── */}
      <div
        className={`min-w-0 flex-shrink-0 flex-col md:w-72 md:border-r ${showList ? "flex border-b md:border-b-0" : "hidden md:flex"}`}
      >
        <div className="border-b p-3 sm:p-4">
          <h2 className="mb-3 text-lg font-semibold" data-testid="text-product-list-title">
            Bale Products
          </h2>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-products"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {productsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredProducts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No products found</p>
          ) : (
            <div className="divide-y">
              {filteredProducts.map((p) => (
                <button
                  key={p.id}
                  className={`w-full px-4 py-3 text-left transition-colors hover-elevate ${
                    selectedProduct?.id === p.id ? "bg-accent text-accent-foreground" : ""
                  }`}
                  onClick={() => {
                    setSelectedProduct(p);
                    setShowList(false);
                  }}
                  data-testid={`button-product-${p.id}`}
                >
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{p.articleCode}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Image Manager ───────────────────────────────── */}
      <div className={`min-w-0 flex-1 flex-col overflow-y-auto ${!showList ? "flex" : "hidden md:flex"}`}>
        {!selectedProduct ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <Images className="mb-4 h-12 w-12 opacity-30" />
            <p className="text-sm">Select a product to manage its images</p>
          </div>
        ) : (
          <div className="space-y-4 p-3 sm:space-y-6 sm:p-6">
            {/* Mobile back button */}
            <div className="-mb-1 md:hidden sm:-mb-2">
              <Button variant="ghost" size="sm" onClick={() => setShowList(true)} data-testid="button-back-to-products">
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back to Products
              </Button>
            </div>
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <PageHeader title={selectedProduct.name} />
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  Article code: <span className="font-mono font-medium">{selectedProduct.articleCode}</span>
                </p>
              </div>
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
                className="w-full sm:w-auto"
                data-testid="button-upload-image"
              >
                {uploadMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Upload Images
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
                data-testid="input-file-upload"
              />
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-md border-2 border-dashed p-5 text-center transition-colors sm:p-8 ${
                dragging ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50"
              }`}
              data-testid="dropzone-images"
            >
              <ImagePlus className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Drag & drop images here, or <span className="font-medium text-primary">click to browse</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">PNG, JPG, WebP — max 10 MB each</p>
            </div>

            {/* Image grid */}
            {imagesQuery.isLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : images.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No images yet. Upload the first one above.
              </div>
            ) : (
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    {images.length} image{images.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 sm:gap-4 md:grid-cols-4">
                  {images.map((img) => (
                    <Card key={img.id} className="group relative overflow-hidden" data-testid={`card-image-${img.id}`}>
                      <div className="relative aspect-square bg-muted">
                        <img
                          src={img.url}
                          alt={img.fileName ?? "product image"}
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors md:bg-black/0 md:group-hover:bg-black/40">
                          <Button
                            size="icon"
                            variant="destructive"
                            className="opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                            onClick={() => deleteMutation.mutate(img.id)}
                            disabled={deleteMutation.isPending}
                            aria-label={`Delete ${img.fileName ?? "product image"}`}
                            data-testid={`button-delete-image-${img.id}`}
                          >
                            {deleteMutation.isPending && deleteMutation.variables === img.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                      <CardContent className="p-2">
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={img.fileName ?? undefined}
                          data-testid={`text-image-filename-${img.id}`}
                        >
                          {img.fileName ?? "image"}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
