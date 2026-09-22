import { useMemo } from "react";

export interface VesselTrailPoint { latitude: string | number; longitude: string | number; observedAt: string; }

/**
 * Dependency-free map-like trail view. It plots the actual sampled AIS observations only;
 * it intentionally does not draw a fabricated port-to-port shipping route or require a paid tile provider.
 */
export function VesselTrailMap({ points }: { points: VesselTrailPoint[] }) {
  const plotted = useMemo(() => {
    const valid = points.map((p) => ({ ...p, lat: Number(p.latitude), lon: Number(p.longitude) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180);
    if (!valid.length) return { valid, coords: [] as Array<{ x: number; y: number }> };
    const lats = valid.map((p) => p.lat), lons = valid.map((p) => p.lon);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const latSpan = Math.max(maxLat - minLat, 0.02), lonSpan = Math.max(maxLon - minLon, 0.02);
    return { valid, coords: valid.map((p) => ({ x: 6 + ((p.lon - minLon) / lonSpan) * 88, y: 94 - ((p.lat - minLat) / latSpan) * 88 })) };
  }, [points]);

  if (!plotted.valid.length) return <div className="h-48 rounded-md border border-dashed flex items-center justify-center text-sm text-muted-foreground">No sampled vessel trail yet.</div>;
  const path = plotted.coords.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const last = plotted.coords[plotted.coords.length - 1];
  return <div className="space-y-2">
    <div className="relative h-52 overflow-hidden rounded-md border bg-muted/20">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-label="Actual AIS vessel trail">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="0.8" vectorEffect="non-scaling-stroke" className="text-primary" />
        {plotted.coords.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i === plotted.coords.length - 1 ? 1.7 : 0.8} fill="currentColor" className={i === plotted.coords.length - 1 ? "text-primary" : "text-muted-foreground"} />)}
        <circle cx={last.x} cy={last.y} r="3" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-primary" />
      </svg>
      <div className="absolute left-2 top-2 rounded bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">AIS observations · not a predicted route</div>
    </div>
    <div className="flex justify-between text-[11px] text-muted-foreground"><span>{plotted.valid.length} sampled positions</span><span>Latest: {new Date(plotted.valid[plotted.valid.length - 1].observedAt).toLocaleString()}</span></div>
  </div>;
}
