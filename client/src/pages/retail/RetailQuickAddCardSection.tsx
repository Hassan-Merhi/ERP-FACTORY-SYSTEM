// Extracted from ./RetailQuickAdd.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NO_BRAND } from "./retailInventoryTypes";
import { useRetailQuickAddState } from "./useRetailQuickAddState";

export function RetailQuickAddCardSection({
  activeLocations,
  brandChoice,
  brands,
  category,
  description,
  existingStyle,
  facets,
  locationId,
  name,
  newBrandName,
  setBrandChoice,
  setCategory,
  setDescription,
  setLocationId,
  setName,
  setNewBrandName,
  setShowDetails,
  showDetails,
  styles,
}: Pick<
  ReturnType<typeof useRetailQuickAddState>,
  | "activeLocations"
  | "brandChoice"
  | "brands"
  | "category"
  | "description"
  | "existingStyle"
  | "facets"
  | "locationId"
  | "name"
  | "newBrandName"
  | "setBrandChoice"
  | "setCategory"
  | "setDescription"
  | "setLocationId"
  | "setName"
  | "setNewBrandName"
  | "setShowDetails"
  | "showDetails"
  | "styles"
>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Style</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="qa-brand">Brand</Label>
          <select
            id="qa-brand"
            className="h-11 w-full rounded-md border bg-background px-3 text-base"
            value={brandChoice}
            onChange={(event) => setBrandChoice(event.target.value)}
          >
            <option value="">{NO_BRAND}</option>
            {brands
              .filter((brand) => !brand.isNoBrand)
              .map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            <option value="new">+ New brand…</option>
          </select>
          {brandChoice === "new" && (
            <Input
              autoFocus
              className="h-11 text-base"
              placeholder="New brand name"
              value={newBrandName}
              onChange={(event) => setNewBrandName(event.target.value)}
            />
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="qa-name">Style / model *</Label>
          <Input
            id="qa-name"
            className="h-11 text-base"
            list="qa-styles"
            placeholder="e.g. Wide Leg Trouser"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <datalist id="qa-styles">
            {styles.map((style) => (
              <option key={style.id} value={style.name} />
            ))}
          </datalist>
          {existingStyle && (
            <p className="text-xs text-primary" data-i18n-ui>
              Adding new colors/sizes to an existing style.
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="qa-location">Location *</Label>
            <select
              id="qa-location"
              className="h-11 w-full rounded-md border bg-background px-3 text-base"
              value={locationId}
              onChange={(event) => setLocationId(event.target.value ? Number(event.target.value) : "")}
            >
              <option value="">Select location</option>
              {activeLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="qa-category">Category</Label>
            <Input
              id="qa-category"
              className="h-11 text-base"
              list="qa-categories"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
            <datalist id="qa-categories">
              {(facets?.categories ?? []).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </div>
        </div>
        {showDetails ? (
          <div className="space-y-1">
            <Label htmlFor="qa-description">Description</Label>
            <Textarea
              id="qa-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowDetails(true)}>
            + Add description
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
