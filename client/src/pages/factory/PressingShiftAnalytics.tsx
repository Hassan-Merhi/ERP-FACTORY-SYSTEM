import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, Clock3, Gauge, PauseCircle, PlayCircle, Plus, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const ROOT = "/api/factory/pressing-machines";
type Shift = { id: number; shiftCode: string; name: string; startLocal: string; endLocal: string;
  timezoneName: string; active: boolean };
type Machine = { id: number; machineCode: string; name: string; targetBalesPerHour?: string | null };
type Downtime = { id: number; machineId: number; reasonCode: string; startedAt: string;
  endedAt: string | null; reasonNotes?: string | null };
type AnalyticsGroup = { productionDate: string; machineId: number; machineName: string;
  shiftId: number | null; bales: number; kg: string; operators: number;
  firstAt: string; lastAt: string; observedSeconds: number;
  balesPerHour: number | null; kgPerHour: number | null };
type Analytics = { groups: AnalyticsGroup[]; summary: { bales: number; kg: number };
  recordedDowntime: Array<Downtime & { machineName: string; seconds: number }>;
  totalDowntimeSeconds: number; machineTargets: Machine[]; rateMethod: string; note: string };
const dateToday = () => {
  const now = new Date();
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),
    String(now.getDate()).padStart(2,"0")].join("-");
};
const displayDate = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("en-GB", {
    day:"2-digit",month:"2-digit",year:"numeric",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,
  });
};
const prettyDuration = (seconds: number) =>
  Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
const message = (e: unknown) => e instanceof Error ? e.message : "Request failed";
async function readJson<T>(uri: string): Promise<T> {
  const response = await fetch(uri, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Unable to read pressing operations ("+response.status+")");
  return response.json() as Promise<T>;
}

function ShiftEditor({ shift, change, busy }: {
  shift: Shift;
  change: (path: string, body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(shift.name);
  const [startLocal, setStart] = useState(shift.startLocal.slice(0,5));
  const [endLocal, setEnd] = useState(shift.endLocal.slice(0,5));
  const [timezoneName, setZone] = useState(shift.timezoneName);
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid={"pressing-shift-"+shift.id}>
      <div className="flex justify-between items-center gap-2">
        <strong className="text-sm">{shift.shiftCode}</strong>
        <Badge variant={shift.active?"default":"secondary"}>{shift.active?"Active":"Disabled"}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <label className="text-xs space-y-1">Shift name
          <Input value={name} maxLength={120} onChange={e=>setName(e.target.value)} />
        </label>
        <label className="text-xs space-y-1">Start time
          <Input type="time" value={startLocal} onChange={e=>setStart(e.target.value)} />
        </label>
        <label className="text-xs space-y-1">End time
          <Input type="time" value={endLocal} onChange={e=>setEnd(e.target.value)} />
        </label>
        <label className="text-xs space-y-1">IANA timezone
          <Input value={timezoneName} onChange={e=>setZone(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy||!name.trim()||startLocal===endLocal}
          onClick={() => change(ROOT+"/shifts/"+shift.id+"/update", {
            name:name.trim(),startLocal,endLocal,timezoneName,
          })}>Save schedule</Button>
        <Button size="sm" variant="outline" disabled={busy}
          onClick={()=>change(ROOT+"/shifts/"+shift.id+"/update",{active:!shift.active})}>
          {shift.active?"Disable shift":"Enable shift"}
        </Button>
      </div>
      {startLocal>endLocal && <p className="text-xs text-muted-foreground">Overnight shift — crosses midnight.</p>}
    </div>
  );
}

export default function PressingShiftAnalytics({
  active, companyId, userId, canManage,
}: {
  active: boolean; companyId: number; userId: string; canManage: boolean;
}) {
  const { toast } = useToast();
  const actor = [companyId,userId];
  const [code,setCode] = useState("");
  const [name,setName] = useState("");
  const [startLocal,setStart] = useState("07:00");
  const [endLocal,setEnd] = useState("15:00");
  const [timezoneName,setZone] = useState("UTC");
  const [downtimeMachine,setDowntimeMachine] = useState("");
  const [reasonCode,setReason] = useState("MAINTENANCE");
  const [reasonNotes,setNotes] = useState("");
  const [from,setFrom] = useState(dateToday);
  const initialDateLoaded = useRef(false);
  const [to,setTo] = useState(dateToday);
  const [machineFilter,setMachineFilter] = useState("");
  const [shiftFilter,setShiftFilter] = useState("");
  const [userFilter,setUserFilter] = useState("");
  const [targetMachine,setTargetMachine] = useState("");
  const [targetRate,setTargetRate] = useState("");

  const factoryCalendar = useQuery<{ serverToday:string; timeZone:string }>({
    queryKey:["/api/factory/pressing-machines/report/options","shift-date",...actor],
    queryFn:()=>readJson(ROOT+"/report/options"),
    enabled:active&&canManage,staleTime:60_000,refetchOnWindowFocus:false,
  });
  useEffect(()=>{
    const day=factoryCalendar.data?.serverToday;
    if(!day||initialDateLoaded.current)return;
    initialDateLoaded.current=true;
    setFrom(day);setTo(day);
  },[factoryCalendar.data?.serverToday]);
  const current = useQuery<{ shift: Shift | null; serverTime: string }>({
    queryKey:[ROOT,"shifts-current",...actor],
    queryFn:()=>readJson(ROOT+"/shifts/current"),
    enabled:active,staleTime:30_000,refetchOnWindowFocus:false,refetchInterval:60_000,
  });
  const shifts = useQuery<Shift[]>({
    queryKey:[ROOT,"shifts-list",...actor],
    queryFn:()=>readJson(ROOT+"/shifts"),
    enabled:active&&canManage,staleTime:30_000,refetchOnWindowFocus:false,
  });
  const machines = useQuery<{ machines: Machine[]; operators: Array<{id:string;username:string}> }>({
    queryKey:[ROOT,"machines-ops",...actor],
    queryFn:()=>readJson(ROOT),
    enabled:active&&canManage,staleTime:30_000,refetchOnWindowFocus:false,
  });
  const downtime = useQuery<Downtime[]>({
    queryKey:[ROOT,"downtime",...actor],
    queryFn:()=>readJson(ROOT+"/downtime"),
    enabled:active&&canManage,staleTime:15_000,refetchOnWindowFocus:false,refetchInterval:30_000,
  });
  const params = new URLSearchParams({from,to});
  if(machineFilter)params.set("machineId",machineFilter);
  if(shiftFilter)params.set("shiftId",shiftFilter);
  if(userFilter)params.set("userId",userFilter);
  const validRange = Boolean(from && to && from<=to &&
    (Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))<=90*86400000);
  const analytics = useQuery<Analytics>({
    queryKey:[ROOT,"analytics",...actor,from,to,machineFilter,shiftFilter,userFilter],
    queryFn:()=>readJson(ROOT+"/analytics?"+params.toString()),
    enabled:active&&canManage&&validRange,staleTime:30_000,refetchOnWindowFocus:false,
  });
  const mutation = useMutation({
    mutationFn:async({uri,body}:{uri:string;body:Record<string,unknown>})=>{
      const response=await apiRequest("POST",uri,body);
      if(!response.ok)throw new Error("Could not save pressing operations");
      return response.json();
    },
    onSuccess:()=>{
      void Promise.all([
        queryClient.invalidateQueries({queryKey:[ROOT,"shifts-current",...actor]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"shifts-list",...actor]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"machines-ops",...actor]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"downtime",...actor]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"analytics",...actor]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"me"]}),
        queryClient.invalidateQueries({queryKey:[ROOT,"dashboard"]}),
      ]);
      toast({title:"Pressing machine operations updated"});
    },
    onError:e=>toast({title:"Could not save",description:message(e),variant:"destructive"}),
  });
  const change=(uri:string,body:Record<string,unknown>)=>mutation.mutate({uri,body});
  const list=machines.data?.machines||[];
  const allShifts=shifts.data||[];
  const openDowntime=(downtime.data||[]).filter(r=>!r.endedAt);
  const targets=analytics.data?.machineTargets||[];
  return (
    <div className="space-y-4" data-testid="pressing-phase7">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base">
          <Clock3 className="h-5 w-5"/>Current Pressing Shift
        </CardTitle></CardHeader>
        <CardContent className="text-sm">
          {current.isLoading&&"Checking server shift…"}
          {current.isError&&<p role="alert" className="text-destructive">{message(current.error)}</p>}
          {current.data?.shift?
            <p><strong>{current.data.shift.name}</strong> ({current.data.shift.shiftCode}) ·
              {current.data.shift.startLocal.slice(0,5)}–{current.data.shift.endLocal.slice(0,5)}
              · {current.data.shift.timezoneName}</p>:
            !current.isLoading&&!current.isError&&<p className="text-muted-foreground">
              No configured shift currently matches server time. Pressing can still be recorded as Unassigned Shift.
            </p>}
        </CardContent>
      </Card>
      {canManage && <>
        <Card>
          <CardHeader><CardTitle className="text-base">Supervisor Shift Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-xs space-y-1">Shift code
                <Input placeholder="SHIFT-A" value={code} onChange={e=>setCode(e.target.value)} maxLength={50}/>
              </label>
              <label className="text-xs space-y-1">Shift name
                <Input placeholder="Morning Shift" value={name} onChange={e=>setName(e.target.value)} maxLength={120}/>
              </label>
              <label className="text-xs space-y-1">Start
                <Input type="time" value={startLocal} onChange={e=>setStart(e.target.value)}/>
              </label>
              <label className="text-xs space-y-1">End
                <Input type="time" value={endLocal} onChange={e=>setEnd(e.target.value)}/>
              </label>
              <label className="text-xs space-y-1">IANA timezone
                <Input placeholder="Africa/Lubumbashi" value={timezoneName} onChange={e=>setZone(e.target.value)}/>
              </label>
            </div>
            <Button size="sm" disabled={mutation.isPending||!name.trim()||!code.trim()||startLocal===endLocal}
              onClick={()=>change(ROOT+"/shifts",{
                shiftCode:code.trim(),name:name.trim(),startLocal,endLocal,timezoneName,active:true,
              })}><Plus className="mr-2 h-4 w-4"/>Add Shift</Button>
            <p className="text-xs text-muted-foreground">
              Shift times are local to the configured IANA timezone. Overnight shifts and daylight saving transitions are recognized.
              Active shifts cannot overlap and must use the same timezone.
            </p>
            {shifts.isError&&<p role="alert" className="text-destructive">{message(shifts.error)}</p>}
            <div className="space-y-2">
              {allShifts.map(row=><ShiftEditor key={row.id} shift={row}
                change={change} busy={mutation.isPending}/>)}
              {!allShifts.length&&!shifts.isLoading&&<p className="text-sm text-muted-foreground">No shifts configured yet.</p>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base">
            <PauseCircle className="h-5 w-5"/>Machine Downtime
          </CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-xs space-y-1">Machine
                <select className="h-10 w-full rounded-md border bg-background px-2" value={downtimeMachine}
                  onChange={e=>setDowntimeMachine(e.target.value)}>
                  <option value="">Select machine</option>
                  {list.map(m=><option key={m.id} value={m.id}>{m.machineCode} — {m.name}</option>)}
                </select>
              </label>
              <label className="text-xs space-y-1">Reason
                <select className="h-10 w-full rounded-md border bg-background px-2" value={reasonCode}
                  onChange={e=>setReason(e.target.value)}>
                  {["MAINTENANCE","MACHINE_FAULT","MATERIAL_SHORTAGE","POWER_OUTAGE","BREAK","OTHER"].map(code=>
                    <option key={code} value={code}>{code.replaceAll("_"," ")}</option>)}
                </select>
              </label>
              <label className="text-xs space-y-1">Notes (optional)
                <Input value={reasonNotes} onChange={e=>setNotes(e.target.value)} maxLength={500}/>
              </label>
            </div>
            <Button size="sm" variant="outline" disabled={!downtimeMachine||mutation.isPending}
              onClick={()=>change(ROOT+"/downtime/start",{
                machineId:Number(downtimeMachine),reasonCode,reasonNotes:reasonNotes.trim(),
              })}><PauseCircle className="mr-2 h-4 w-4"/>Start Downtime</Button>
            <p className="text-xs text-muted-foreground">Pressing confirmations are blocked while a machine has open downtime.</p>
            {downtime.isError&&<p role="alert" className="text-destructive">{message(downtime.error)}</p>}
            <div className="space-y-2">
              {openDowntime.map(d=>(
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
                  <div><strong className="text-sm">Machine #{d.machineId} · {d.reasonCode.replaceAll("_"," ")}</strong>
                    <p className="text-xs text-muted-foreground">Started {displayDate(d.startedAt)}</p></div>
                  <Button size="sm" disabled={mutation.isPending} onClick={()=>
                    change(ROOT+"/downtime/"+d.id+"/end",{})}>
                    <PlayCircle className="mr-2 h-4 w-4"/>End Downtime
                  </Button>
                </div>
              ))}
              {openDowntime.length===0&&<p className="text-xs text-muted-foreground">No machine is currently marked down.</p>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5"/>Machine Productivity & Analytics
          </CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-xs space-y-1">From
                <Input type="date" value={from} onChange={e=>setFrom(e.target.value)}/>
              </label>
              <label className="text-xs space-y-1">To
                <Input type="date" value={to} onChange={e=>setTo(e.target.value)}/>
              </label>
              <label className="text-xs space-y-1">Machine
                <select className="h-10 w-full rounded-md border bg-background px-2" value={machineFilter}
                  onChange={e=>setMachineFilter(e.target.value)}>
                  <option value="">All machines</option>
                  {list.map(m=><option key={m.id} value={m.id}>{m.machineCode}</option>)}
                </select>
              </label>
              <label className="text-xs space-y-1">Shift
                <select className="h-10 w-full rounded-md border bg-background px-2" value={shiftFilter}
                  onChange={e=>setShiftFilter(e.target.value)}>
                  <option value="">All shifts</option>
                  {allShifts.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="text-xs space-y-1">Operator
                <select className="h-10 w-full rounded-md border bg-background px-2" value={userFilter}
                  onChange={e=>setUserFilter(e.target.value)}>
                  <option value="">All operators</option>
                  {(machines.data?.operators||[]).map(o=><option key={o.id} value={o.id}>{o.username}</option>)}
                </select>
              </label>
            </div>
            {!validRange&&<p role="alert" className="text-sm text-destructive">Select a valid range of up to 91 days.</p>}
            <Button size="sm" variant="outline" onClick={()=>
              void queryClient.invalidateQueries({queryKey:[ROOT,"analytics",...actor]})}>
              <RefreshCw className="mr-2 h-4 w-4"/>Refresh Analytics
            </Button>
            {analytics.isError&&<p role="alert" className="text-destructive">{message(analytics.error)}</p>}
            {analytics.isLoading&&<p className="text-sm">Calculating machine performance…</p>}
            {analytics.data&&<>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border bg-muted/20 p-3"><p className="text-xs">Confirmed Bales</p>
                  <strong className="text-xl">{analytics.data.summary.bales.toLocaleString()}</strong></div>
                <div className="rounded-md border bg-muted/20 p-3"><p className="text-xs">Confirmed KG</p>
                  <strong className="text-xl">{analytics.data.summary.kg.toLocaleString(undefined,{maximumFractionDigits:3})}</strong></div>
                <div className="rounded-md border bg-muted/20 p-3"><p className="text-xs">Recorded downtime</p>
                  <strong className="text-lg">{prettyDuration(analytics.data.totalDowntimeSeconds)}</strong></div>
              </div>
              <p className="text-xs text-muted-foreground">{analytics.data.note}</p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[810px] text-left text-sm">
                  <thead className="bg-muted"><tr>{[
                    "Date","Machine","Shift","Bales","KG","Operators",
                    "Observed h","Bales / h","KG / h","Target bales / h",
                  ].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead>
                  <tbody>
                    {analytics.data.groups.map((row,i)=>(
                      <tr key={row.productionDate+":"+row.machineId+":"+row.shiftId+":"+i} className="border-t">
                        <td className="p-2">{row.productionDate}</td>
                        <td className="p-2">{row.machineName}</td>
                        <td className="p-2">{allShifts.find(x=>x.id===row.shiftId)?.name||"Unassigned"}</td>
                        <td className="p-2 tabular-nums">{row.bales}</td>
                        <td className="p-2 tabular-nums">{Number(row.kg).toLocaleString()}</td>
                        <td className="p-2">{row.operators}</td>
                        <td className="p-2 tabular-nums">{(row.observedSeconds/3600).toFixed(2)}</td>
                        <td className="p-2 tabular-nums">{row.balesPerHour??"—"}</td>
                        <td className="p-2 tabular-nums">{row.kgPerHour??"—"}</td>
                        <td className="p-2 tabular-nums">{targets.find(t=>t.id===row.machineId)?.targetBalesPerHour??"—"}</td>
                      </tr>
                    ))}
                    {!analytics.data.groups.length&&<tr><td colSpan={10} className="p-3 text-center text-muted-foreground">
                      No confirmed bales in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2">
                <strong className="text-sm">Recorded downtime (latest intervals)</strong>
                {analytics.data.recordedDowntime.slice(0,20).map(d=><p key={d.id} className="text-xs rounded-md border p-2">
                  {d.machineName} · {d.reasonCode.replaceAll("_"," ")} ·
                  {prettyDuration(d.seconds)} · {displayDate(d.startedAt)} – {d.endedAt?displayDate(d.endedAt):"Ongoing"}
                </p>)}
              </div>
            </>}
            <div className="border-t pt-3 space-y-2">
              <strong className="flex items-center gap-2 text-sm"><Gauge className="h-4 w-4"/>Machine Target</strong>
              <div className="flex flex-wrap gap-2">
                <select className="h-10 min-w-[140px] rounded-md border bg-background px-2 text-sm"
                  value={targetMachine} onChange={e=>setTargetMachine(e.target.value)}>
                  <option value="">Choose machine</option>
                  {list.map(m=><option key={m.id} value={m.id}>{m.machineCode}</option>)}
                </select>
                <Input type="number" min="0.001" step="0.001" max="100000"
                  placeholder="Target bales/hour" value={targetRate}
                  onChange={e=>setTargetRate(e.target.value)} className="max-w-[200px]"/>
                <Button size="sm" variant="outline"
                  disabled={!targetMachine||!(Number(targetRate)>0)||mutation.isPending}
                  onClick={()=>change(ROOT+"/"+targetMachine+"/update",{
                    targetBalesPerHour:Number(targetRate),
                  })}>Save Target</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Targets are planning values. Observed rate requires at least two confirmed scans; it is not a measured mechanical cycle time.
              </p>
            </div>
          </CardContent>
        </Card>
      </>}
    </div>
  );
}
