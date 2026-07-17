// Generates a Word (.docx) tenancy agreement from a lease, mirroring the
// owner's existing template (cover page, covenants 2.x / 3.x / 4.x, signature
// block, Schedules A–J). Tenancy-specific values (parties, premises, term,
// rent, deposit) are auto-filled from the lease; signatory names, bank details,
// utility deposit, use-of-premises and renewal option remain quick fill-in
// blanks because the app does not store them.
import {
  AlignmentType,
  BorderStyle,
  Document,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Company, Lease, Property, Tenant } from "@prisma/client";

const HANGING = 720; // 0.5 inch in twips

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "____________";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}
function fmtDateLong(d: Date | null | undefined): string {
  if (!d) return "____________";
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function money(v: unknown, sym: string): string {
  const n = Number(v) || 0;
  const [intp, dec] = n.toFixed(2).split(".");
  return `${sym} ${intp.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}

function center(text: string, bold = false, size?: number): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text, bold, size })],
  });
}
function heading(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, bold: true })] });
}
function body(text: string): Paragraph {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: [new TextRun(text)] });
}
function clause(num: string, text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120 },
    indent: { left: HANGING, hanging: HANGING },
    children: [new TextRun({ text: `${num}\t${text}` })],
  });
}
function blank(): Paragraph {
  return new Paragraph({ children: [new TextRun("")] });
}

const TENANT_COVENANTS: [string, string][] = [
  ["2.1", "To pay the said rent without deduction monthly in advance. The first payment to be made upon execution of this Agreement and thereafter before the Seventh (7) day when rental is due."],
  ["2.2", "To pay a rental deposit stipulated in Schedule G to the Landlord by the Tenant subject to the deduction of any sum or sums which may be lawfully due from the Tenant to the Landlord at the termination of this lease."],
  ["2.3", "To pay the utility deposit as stipulated in Schedule H to the Landlord. Such deposits shall be refundable by Tenant at the termination of this lease provided all electricity, sewerage and water bills have been settled up to the date of vacating the Said Premises."],
  ["2.4", "To keep and maintain the Said Premises in good and tenantable condition throughout the term granted and to yield up the same in such tenantable repair and condition on the termination of this Agreement."],
  ["2.5", "To keep the whole said premises in a clean and proper condition."],
  ["2.6", "To permit the Landlord or his agent to enter upon and examine the condition of the Said Premises at all reasonable times."],
  ["2.7", "To pay for all charges monthly in respect of electric, sewerage and water consumed in the said premises during the term herein reserved."],
  ["2.8", "Not to do or permit to be done anything whereby the policy or policies of insurance of the demised premises against damage by fire may become void or voidable or whereby the rate of premium may be increased and to repay to the Landlord on demand all sums paid by way of increased premium and all expenses incurred by the landlord in or above any renewal of such policy or policies rendered necessary by a breach of this covenant."],
  ["2.9", "Not to store or bring upon the Demised Premises any article or articles of especially combustible, inflammable or dangerous nature."],
  ["2.10", "To observe and comply with all laws, by laws rules and regulations affecting the Tenant of the Demised Premises which are for the time being enforced which may hereinafter be enacted by the Municipality or Town Board of the area."],
  ["2.11", "Not to do or permit or suffer to be done in or upon the Said Premises or any part thereof anything, which may be or become a nuisance or cause damage or inconvenience to the Landlord or the Tenant or occupants of the neighboring premises."],
  ["2.12", "Not to assign or sublet or part with possession of the Said Premises or any part thereof without the previous consent of the Landlord in writing."],
  ["2.13", "At the termination of this Agreement to yield up vacant possession of the Said Premises and all additions there to and the fittings and fixtures in good and tenantable repair and condition. The Tenant may however, remove any furniture, fittings and fixtures installed by him provided he makes good any damage caused by such removal."],
  ["2.14", "To compensate the Landlord for any fittings and fixtures damaged or destroyed by any willful default or neglect of the Tenant other than fair, wear and tear."],
  ["2.15", "To use the Demised Premises only for the purposes specified in Schedule I. Not to suffer or permit to suffer the said Premises to be used for any unlawful purposes."],
  ["2.16", "For sixty (60) days before the expiration of the Tenancy the landlord or his agents shall be permitted to enter the Said Premises at reasonable times to show the property for RENT or SALE and to keep a \"TO LET\" or \"FOR SALE\" sign displayed at the Said Premises."],
  ["2.17", "Not to utilize the security deposit to pay off the rentals for the last two (2) months of the tenancy term, in default of which the Landlord has the right to re-enter upon the Said Premises at any time thereafter."],
];
const LANDLORD_COVENANTS: [string, string][] = [
  ["3.1", "To maintain and keep the main structure of the Said Premises that is the roof, main walls, timber, drains, water pipes and electrical wiring, in good and tenantable repair and condition throughout the term hereby created except as regards damage to the premises caused by or resulting from any act of default or negligence of the Tenant or his servants and except as herein before covenanted to be done by the Tenant, then the Tenant shall carry out such repairs at their own cost and expenses."],
  ["3.2", "Tenant paying the rent hereby reserved and performing and observing the several stipulations on his part herein contained shall peacefully hold and enjoy the Said Premises without interruption by the Landlord or any person rightfully claiming under or in trust for him."],
];
const GENERAL: [string, string][] = [
  ["4.1", "If the rent or part there of shall be unpaid by 7th day when rental is due every month (whether formally demanded or not) or if the tenant shall omit to perform or observe any stipulation here in its part contained then it shall be lawfully for the landlord at any time, thereafter to re-enter upon the Said Premises or any part thereof in the name of whole and there upon this Agreement shall determine but without prejudice to any claim of the landlord in respect of any breach of tenant's stipulations here in contained."],
  ["4.2", "If the Said Premises shall be destroyed or damaged by fire or shall otherwise become unfit for use or occupation the rent here by reserved or a due proportion there of shall cease until the complete restoration of the Said Premises."],
  ["4.3", "If the tenant shall be desirous of renewing this lease for a further period as stipulated in the Schedule J, he shall have the option to do so on mutually agreed terms, conditions and revised new rental, provided he notifies the landlord by writing, two (2) months before expiry of this lease."],
  ["4.4", "If the landlord or tenant desire to terminate the term here by granted, either party may give two (2) months' notice in advance, in respect of such termination or two (2) months' rent in lieu thereof. In the event the tenant terminates the lease earlier, the rental deposit will be forfeited automatically."],
  ["4.5", "If the landlord's fixtures and fittings (including floorings, lighting, electric wire) there in which shall be broken or damage due to malicious, negligent or careless acts of the tenant, the tenant shall be wholly responsible and shall fully indemnify the landlord against all claims, demands, actions and legal proceedings whats over made upon the landlord by any person in respect thereof."],
  ["4.6", "Any notice requiring to be served hereunder shall be in writing and shall be served on Tenant, if left addressed to him at the Demised Premises or forwarded to him to his last known place and any notice to the landlord shall be sufficiently served if sent by registered post, courier or delivered to him personally."],
  ["4.7", "This Agreement shall be binding on the personal representatives and assigns of the landlord and the successor and assigns of the tenant."],
  ["4.8", "All costs and expenses incidental to the preparation and execution of Tenancy Agreement including the Stamp Duty fees shall be borne and paid by the tenant."],
  ["4.9", "Time wherever mentioned shall be of the essence."],
];

function sigBlock(label: string): Paragraph[] {
  return [
    heading(label),
    blank(),
    new Paragraph({ children: [new TextRun("\t\t\t> …………………………………………..")] }),
    new Paragraph({ children: [new TextRun("\t\t\tName: [______________________________]")] }),
    new Paragraph({ children: [new TextRun("\t\t\tNRIC: [______________________________]")] }),
    blank(),
  ];
}

function cell(text: string, opts: { bold?: boolean; width: number; center?: boolean }): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.PERCENTAGE },
    children: text.split("\n").map(
      (line) =>
        new Paragraph({
          alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: [new TextRun({ text: line, bold: opts.bold })],
        }),
    ),
  });
}

export async function buildTenancyAgreementDocx(input: {
  company: Company;
  property: Property;
  tenant: Tenant;
  lease: Lease;
}): Promise<Buffer> {
  const { company, property, tenant, lease } = input;
  const sym = company.currency || "RM";
  const landlordLine = company.registrationNo ? `${company.name} (${company.registrationNo})` : company.name;
  const tenantLine = tenant.idNumber ? `${tenant.name} (${tenant.idNumber})` : tenant.name;
  const term = `${fmtDate(lease.startDate)} – ${lease.endDate ? fmtDate(lease.endDate) : "[end date]"}`;
  const premises = property.address ? `${property.name}, ${property.address}` : property.name;

  const B = { style: BorderStyle.SINGLE, size: 1, color: "000000" } as const;
  const scheduleRows: [string, string, string][] = [
    ["A", "This day and year of This Agreement", `On ${fmtDateLong(lease.signedDate)}`],
    ["B", "Name and address of the Landlord", `${landlordLine}\n[Landlord address]\nH/P: [__________]`],
    ["C", "Name and address of the Tenant", `${tenantLine}\n[Tenant address]`],
    ["D", "Description of the Demised premises", premises],
    ["E", "Term of Tenancy", term],
    ["F", "Rental per month", `${money(lease.monthlyRent, sym)} per month`],
    ["G", "Rental Deposit", money(lease.depositAmount, sym)],
    ["H", "Utility Deposit", "[Utility deposit / N/A]"],
    ["I", "Use of Demised premises", "[Use of premises — e.g. RESIDENTIAL / REGISTERED LEGAL BUSINESS]"],
    ["J", "Option to renew", "[Option to renew — e.g. 2 years at market rate]"],
  ];

  const children: Paragraph[] = [];

  // Cover page
  for (let i = 0; i < 6; i++) children.push(blank());
  children.push(center(`DATED   ${fmtDateLong(lease.signedDate)}`, true));
  children.push(blank(), blank());
  children.push(center("BETWEEN", true));
  children.push(blank(), blank());
  children.push(center(company.name, true));
  children.push(center(`${company.registrationNo ? `(${company.registrationNo})` : ""} …………………. LANDLORD`, true));
  children.push(blank(), blank());
  children.push(center("AND", true));
  children.push(blank(), blank());
  children.push(center(tenant.name, true));
  children.push(center(`${tenant.idNumber ? `(${tenant.idNumber})` : ""} …………………. TENANT`, true));
  children.push(blank(), blank(), blank());
  children.push(center("*".repeat(64)));
  children.push(center("TENANCY  AGREEMENT", true));
  children.push(center("*".repeat(64)));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Body
  children.push(center("TENANCY AGREEMENT", true));
  children.push(blank());
  children.push(body(`AN AGREEMENT made the day and year stated in Schedule A between the party whose name and address are stated in Schedule B (herein after called "The Landlord") of the one part and the party whose name and address are stated in Schedule C (herein after called "The Tenant") of the other part.`));
  children.push(body(`WHEREAS the landlord is desirous of leasing to the Tenant and the Tenant is desirous to taking on lease from the Landlord all lot and building described in Schedule D (hereinafter called "The Said Premises").`));
  children.push(body("NOW IT IS HEREBY AGREED as follows:-"));
  children.push(clause("1.", "The Landlord will grant and the Tenant will accept a lease of the Said premises for a term stipulated in Schedule E at the rent stipulated in Schedule F and subject to the terms and conditions hereinafter contained."));
  children.push(heading("2.\tTHE TENANT HEREBY COVENANTS WITH THE LANDLORDS AS FOLLOWING:-"));
  for (const [n, t] of TENANT_COVENANTS) children.push(clause(n, t));
  children.push(heading("3.\tTHE LANDLORD HEREBY COVENANTS WITH THE TENANT AS FOLLOWS:-"));
  for (const [n, t] of LANDLORD_COVENANTS) children.push(clause(n, t));
  children.push(heading("4.\tPROVIDED ALWAYS AND IT IS HEREBY EXPRESSLY AGREED BETWEEN THE PARTIES AS FOLLOWS:-"));
  for (const [n, t] of GENERAL) children.push(clause(n, t));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Signatures
  children.push(body("IN WITNESS WHEREOF the parties hereto have hereunto set their hands the day and year set out in Schedule A of the Schedule of the Agreement"));
  children.push(blank());
  for (const label of ["SIGNED BY THE SAID LANDLORD", "IN THE PRESENCE OF :-", "SIGNED BY THE SAID TENANT", "IN THE PRESENCE OF :-"]) {
    for (const par of sigBlock(label)) children.push(par);
  }
  children.push(heading("LANDLORD'S BANK DETAILS (for rental payment):"));
  children.push(new Paragraph({ children: [new TextRun("BANK NAME\t\t: [__________________________]")] }));
  children.push(new Paragraph({ children: [new TextRun("BANK ACC NO\t\t: [__________________________]")] }));
  children.push(new Paragraph({ children: [new TextRun(`NAME OF AC HOLDER\t: ${company.name}`)] }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Schedules
  children.push(center("SCHEDULES", true, 28));
  children.push(center("(which is part of this Agreement)"));

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: B, bottom: B, left: B, right: B, insideHorizontal: B, insideVertical: B },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          cell("SCHEDULE", { bold: true, width: 15, center: true }),
          cell("ITEM", { bold: true, width: 30, center: true }),
          cell("PARTICULARS", { bold: true, width: 55, center: true }),
        ],
      }),
      ...scheduleRows.map(
        ([s, item, particulars]) =>
          new TableRow({
            children: [
              cell(s, { width: 15, center: true }),
              cell(item, { width: 30 }),
              cell(particulars, { width: 55 }),
            ],
          }),
      ),
    ],
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
    sections: [{ children: [...children, table] }],
  });

  return Packer.toBuffer(doc);
}
