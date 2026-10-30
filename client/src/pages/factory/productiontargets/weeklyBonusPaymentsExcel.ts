import type ExcelJS from "exceljs";

export interface WeeklyBonusPaymentExportRow {
  reviewId: number | string;
  weekStart: string;
  weekEnd: string;
  workerId: number;
  workerName: string;
  targetBales: string;
  creditedBales: number;
  extraBales: string;
  approvedAmount: string;
  methodVersionId: number;
  decisionStatus: "approved" | "rejected";
  reviewedBy: string;
  reviewedAt: string;
  snapshot: {
    categories?: Array<{categoryLabel: string; creditedBales: number}>;
    days?: Array<{date:string; creditedBales:number; targetBales:string | null}>;
  } | null;
  paymentId: number | string | null;
  paymentStatus: "POSTED" | "REVERSED" | null;
  paymentDate: string | null;
  cashAccountName: string | null;
  voucherId: number | null;
  reversalVoucherId: number | null;
}
const NAVY = "FF17324F", PALE = "FFF1F5F9", WHITE = "FFFFFFFF";
const safeText = (text: string | null | undefined) => {
  const value = String(text ?? "").replace(/[\u0000-\u001F]/g, " ").slice(0, 1000);
  return /^[=+\-@]/.test(value) ? "'" + value : value;
};
const money = (value: string | number) => Math.round(Number(value) * 100) / 100;
function setup(
  book: ExcelJS.Workbook, name: string, title: string, subtitle: string,
  headers: string[], widths: number[], currencyCols: number[],
): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(name);
  sheet.mergeCells(1,1,2,headers.length);
  const titleCell = sheet.getCell(1,1);
  titleCell.value=title;
  titleCell.font={name:"Aptos Display",bold:true,size:16,color:{argb:WHITE}};
  titleCell.fill={type:"pattern",pattern:"solid",fgColor:{argb:NAVY}};
  titleCell.alignment={indent:1,vertical:"middle"};
  sheet.getRow(1).height=27;
  sheet.getRow(2).height=18;
  sheet.mergeCells(3,1,3,headers.length);
  sheet.getCell(3,1).value=subtitle;
  sheet.getCell(3,1).font={name:"Aptos",size:10,color:{argb:NAVY}};
  sheet.getRow(3).height=25;
  const heading=sheet.getRow(5);
  heading.values=headers;heading.height=32;
  heading.eachCell(cell=>{
    cell.font={name:"Aptos",bold:true,size:10,color:{argb:WHITE}};
    cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:NAVY}};
    cell.alignment={vertical:"middle",wrapText:true};
  });
  widths.forEach((v,i)=>{sheet.getColumn(i+1).width=v;});
  currencyCols.forEach(c=>{sheet.getColumn(c).numFmt="#,##0.00;[Red](#,##0.00)";});
  sheet.views=[{state:"frozen",ySplit:5,showGridLines:false}];
  sheet.pageSetup={paperSize:9,orientation:"landscape",fitToPage:true,fitToWidth:1,
    fitToHeight:0,margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2}};
  return sheet;
}
function row(sheet:ExcelJS.Worksheet,values:Array<string|number|null>){
  const r=sheet.addRow(values.map(v=>typeof v==="string"?safeText(v):v??""));
  r.height=24;
  r.eachCell({includeEmpty:true},c=>{
    c.font={name:"Aptos",size:10,color:{argb:NAVY}};
    c.fill={type:"pattern",pattern:"solid",fgColor:{argb:r.number%2?PALE:WHITE}};
    c.alignment={vertical:"middle",wrapText:true};
  });
}
function complete(sheet:ExcelJS.Worksheet,cols:number,note:string){
  if(sheet.rowCount>5)sheet.autoFilter={
    from:{row:5,column:1},to:{row:sheet.rowCount,column:cols},
  };
  const footer=sheet.rowCount+2;
  sheet.mergeCells(footer,1,footer,cols);
  sheet.getCell(footer,1).value=note;
  sheet.getCell(footer,1).font={name:"Aptos",size:10,italic:true};
  sheet.getRow(footer).height=30;
}

/** One immutable worker/week row; never multiply category-level amounts or linked shares. */
export function buildWeeklyBonusPaymentsWorkbook(
  rows: WeeklyBonusPaymentExportRow[], start: string, end: string,
  WorkbookCtor: new()=>ExcelJS.Workbook,
): ExcelJS.Workbook {
  const book=new WorkbookCtor();
  book.creator="Factory Production Targets";
  const subtitle="Monday production weeks: "+start+" to "+end+" | USD · approved and paid are separate";
  const detail=setup(book,"Weekly Bonus Audit","PRODUCTION TARGETS | WEEKLY FLAT BONUSES",subtitle,
    ["Week Start","Week End","Worker","Worker ID","Weekly Target","Credited Bales","Above Target",
      "Categories","Flat Bonus (USD)","Decision","Payment Status","Payment Date","Paying Account",
      "Payment Voucher","Reversal Voucher","Fee Version","Reviewer","Reviewed At"],
    [16,16,32,13,17,17,17,45,19,15,17,16,26,18,18,15,26,22],[9]);
  const ordered=[...rows].sort((a,b)=>a.weekStart.localeCompare(b.weekStart)||
    a.workerName.localeCompare(b.workerName)||a.workerId-b.workerId);
  for(const item of ordered){
    const categories=(item.snapshot?.categories??[])
      .map(c=>c.categoryLabel+" ("+c.creditedBales+")").join(", ");
    row(detail,[item.weekStart,item.weekEnd,item.workerName,item.workerId,
      Number(item.targetBales),item.creditedBales,Number(item.extraBales),
      categories,money(item.approvedAmount),item.decisionStatus,
      item.paymentStatus??(item.decisionStatus==="approved"?"UNPAID":"NOT PAYABLE"),
      item.paymentDate,item.cashAccountName,item.voucherId,
      item.reversalVoucherId,item.methodVersionId,item.reviewedBy,item.reviewedAt]);
  }
  complete(detail,18,"Every row is one immutable reviewed worker/week, even when workers switched categories. A REVERSED payment is not a fresh entitlement.");

  const totals=setup(book,"Worker Totals","WEEKLY BONUSES | WORKER TOTALS",subtitle,
    ["Worker","Worker ID","Reviewed Weeks","Approved & Unpaid USD","Paid USD",
      "Reversed Gross USD","Approved Decisions","Rejected Decisions"],
    [33,15,18,24,18,23,20,20],[4,5,6]);
  const byWorker=new Map<number,{name:string;count:number;unpaid:number;paid:number;
    reversed:number;approved:number;rejected:number}>();
  for(const item of rows){
    const rec=byWorker.get(item.workerId)??{name:item.workerName,count:0,unpaid:0,
      paid:0,reversed:0,approved:0,rejected:0};
    rec.count++;
    const amt=money(item.approvedAmount);
    if(item.decisionStatus==="approved"){
      rec.approved++;
      if(item.paymentStatus==="POSTED")rec.paid+=amt;
      else if(item.paymentStatus==="REVERSED")rec.reversed+=amt;
      else rec.unpaid+=amt;
    }else rec.rejected++;
    byWorker.set(item.workerId,rec);
  }
  for(const [workerId,rec] of [...byWorker].sort((a,b)=>a[1].name.localeCompare(b[1].name))){
    row(totals,[rec.name,workerId,rec.count,money(rec.unpaid),money(rec.paid),
      money(rec.reversed),rec.approved,rec.rejected]);
  }
  complete(totals,8,"Paid = posted and not reversed. Reversed gross is shown separately; it is NOT an unpaid amount eligible for repayment.");
  return book;
}

export async function exportWeeklyBonusPaymentsExcel(
  rows: WeeklyBonusPaymentExportRow[],start:string,end:string,
):Promise<void>{
  const imported=await import("exceljs");
  const runtime=imported.default??imported;
  const workbook=buildWeeklyBonusPaymentsWorkbook(rows,start,end,runtime.Workbook);
  const buffer=await workbook.xlsx.writeBuffer();
  const blob=new Blob([buffer],{
    type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url=URL.createObjectURL(blob);
  try{
    const a=document.createElement("a");
    a.href=url;a.download="Weekly_Production_Bonuses_"+start+"_to_"+end+".xlsx";
    document.body.appendChild(a);a.click();a.remove();
  }finally{window.setTimeout(()=>URL.revokeObjectURL(url),1500);}
}
