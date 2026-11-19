// Extracted from ./CreateBaleProductDialog.tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { FactoryCategory } from "@shared/schema";

const formSchema = z.object({
  grade: z.string().min(1, "Grade is required"),
  name: z.string().min(1, "English product name is required"),
  nameAr: z.string().optional(),
  categoryId: z.string().optional(),
  weightPerBaleKg: z.string().optional(),
  description: z.string().optional(),
  descriptionAr: z.string().optional(),
  productionPrice: z.string().optional(),
  sellingPrice: z.string().optional(),
  labelDesignColor: z.string().optional(),
});

export interface CreateBaleProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminAuth?: { username: string; password: string } | null;
  onClose?: () => void;
}

export function useCreateBaleProductDialogState({
  onOpenChange,
  adminAuth,
}: Pick<CreateBaleProductDialogProps, "onOpenChange" | "adminAuth">) {
  const { toast } = useToast();
  const { colors } = useLabelDesignColors();
  const canCreateProduct = useExistingRecordChangeAccess().canCreate("POST", "/api/factory/bale-products");

  const { data: categories } = useQuery<FactoryCategory[]>({
    queryKey: ["/api/factory/categories"],
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      grade: "",
      name: "",
      nameAr: "",
      categoryId: "",
      weightPerBaleKg: "",
      description: "",
      descriptionAr: "",
      productionPrice: "",
      sellingPrice: "",
      labelDesignColor: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema>) => {
      const body: Record<string, unknown> = {
        name: data.name.trim(),
        nameEn: data.name.trim(),
        nameAr: data.nameAr?.trim() || null,
        descriptionEn: data.description?.trim() || null,
        descriptionAr: data.descriptionAr?.trim() || null,
        grade: data.grade,
      };
      if (data.categoryId && data.categoryId !== "none") body.categoryId = Number.parseInt(data.categoryId, 10);
      if (data.weightPerBaleKg) body.weightPerBaleKg = data.weightPerBaleKg;
      if (data.description) body.description = data.description.trim();
      if (data.productionPrice) body.productionPrice = data.productionPrice;
      if (data.sellingPrice) body.sellingPrice = data.sellingPrice;
      if (data.labelDesignColor) body.labelDesignColor = data.labelDesignColor;
      if (adminAuth) body.adminAuth = adminAuth;

      const response = await factoryApiRequest("POST", "/api/factory/bale-products", body);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Failed to create product");
      return payload;
    },
    onSuccess: (product: { name?: string; nameEn?: string; articleCode?: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Product created",
        description: `"${product.nameEn || product.name || "Product"}" created with article code ${product.articleCode || "—"}`,
      });
      form.reset();
      onOpenChange(false);
    },
    onError: (error: Error) => {
      if ((error as Error & { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });
  return { colors, canCreateProduct, categories, form, createMutation };
}
