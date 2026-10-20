import {
  encodeSegment,
  marketsharpRequest,
  MarketSharpApiError,
  type MarketSharpRequest,
} from '../client.js';
import type { MarketSharpCredentials } from '../types.js';
import { compact, optBool, optEnum, optInt, optString, optStringArray, reqString, type Args } from './args.js';

export type ToolTier = 'read' | 'write';

export interface ToolDef {
  name: string;
  description: string;
  tier: ToolTier;
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[]; additionalProperties?: boolean };
  /** Build the single MarketSharp request for this call. */
  build?: (args: Args, creds: MarketSharpCredentials) => MarketSharpRequest;
  /** Custom runner for tools that need more than one request. */
  run?: (args: Args, creds: MarketSharpCredentials) => Promise<string>;
}

const s = (description: string, extra: object = {}) => ({ type: 'string', description, ...extra });
const i = (description: string, minimum: number, maximum: number) => ({ type: 'integer', description, minimum, maximum });
const b = (description: string) => ({ type: 'boolean', description });

const DATE_HINT = 'Date/time in the MarketSharp company time zone, e.g. 2026-10-01 or 2026-10-01T08:00:00.';
const NOTE_TYPES = [
  'Activity', 'AdditionalContact', 'Appointment', 'ContactNote', 'Finance', 'Inquiry', 'Job',
  'JobProduct', 'JobProductDetail', 'Production', 'Proposal', 'ServiceOrder', 'Testimonial', 'WorkOrder',
] as const;
const EMPLOYEE_NOTE = " Needs an Employee ID on the connection, and runs with that employee's MarketSharp permissions.";

const company = (c: MarketSharpCredentials) => `/companies/${encodeSegment(c.companyId, 'Company ID')}`;

const searchProps = {
  first_name: s('First name, or the start of it.'),
  last_name: s('Last name, or the start of it.'),
  business_name: s('Business name.'),
  email_address: s('Email address.'),
  phone_number: s('Phone number, digits only is fine.'),
  address_line_one: s('Street address line 1.'),
  city: s('City.'),
  state: s('State, e.g. MI.'),
  zip: s('ZIP code.'),
  numberOfRecords: i('Most records to return. MarketSharp defaults to 100.', 1, 500),
};
const SEARCH_KEYS = Object.keys(searchProps).filter((k) => k !== 'numberOfRecords');

function searchBody(args: Args, extraKeys: string[] = []): Record<string, unknown> {
  const keys = [...SEARCH_KEYS, ...extraKeys];
  const body: Record<string, unknown> = {};
  for (const k of keys) body[k] = optString(args, k, 200);
  if (!keys.some((k) => body[k] !== undefined)) {
    throw new MarketSharpApiError(`Give at least one search field: ${keys.join(', ')}.`);
  }
  body.numberOfRecords = optInt(args, 'numberOfRecords', 1, 500);
  return compact(body);
}

const pagingProps = {
  pageNumber: i('Page to return, starting at 1.', 1, 100000),
  rowsPerPage: i('Rows per page. Keep this small (MarketSharp defaults to 1000).', 1, 1000),
};
const DEFAULT_ROWS = 100;

/** Unwrap MarketSharp's {meta, response} envelope and a single-element array. */
function unwrapRecord(text: string): Record<string, unknown> | undefined {
  try {
    let body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body) && 'response' in (body as object)) {
      body = (body as { response: unknown }).response;
    }
    if (Array.isArray(body)) body = body[0];
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const TOOLS: ToolDef[] = [
  // ---------------------------------------------------------------- company
  {
    name: 'marketsharp_companies_list',
    tier: 'read',
    description: 'List the MarketSharp companies this API key can access, with their IDs.',
    inputSchema: { type: 'object', properties: {} },
    build: () => ({ method: 'GET', path: '/companies' }),
  },
  {
    name: 'marketsharp_companies_get',
    tier: 'read',
    description: "Get this connection's MarketSharp company profile (name, address, time zone and settings).",
    inputSchema: { type: 'object', properties: {} },
    build: (_a, c) => ({ method: 'GET', path: company(c) }),
  },
  {
    name: 'marketsharp_search_global',
    tier: 'read',
    description:
      'Search the company for contacts, inquiries (leads) and jobs by name, address, email, phone or job number. Start here when you only have a name or phone number.',
    inputSchema: {
      type: 'object',
      properties: {
        query: s('Text to look for: a name, address, email, phone number or job number.'),
        type: s('Limit results to one kind of record.', { enum: ['All', 'Contact', 'Inquiry', 'Job'] }),
        numberOfRecords: i('Most results to return (default 25).', 1, 200),
      },
      required: ['query'],
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/search/global`,
      body: {
        entry: reqString(a, 'query', 200),
        searchObjectType: optEnum(a, 'type', ['All', 'Contact', 'Inquiry', 'Job'] as const) ?? 'All',
        numberOfRecords: optInt(a, 'numberOfRecords', 1, 200) ?? 25,
        multiCompany: false,
      },
    }),
  },
  // --------------------------------------------------------------- contacts
  {
    name: 'marketsharp_contacts_get',
    tier: 'read',
    description: 'Get one contact (customer or prospect) by contact ID: name, addresses, emails, phone numbers and do-not-contact flags.',
    inputSchema: { type: 'object', properties: { contactId: s('MarketSharp contact ID.') }, required: ['contactId'] },
    build: (a, c) => ({ method: 'GET', path: `${company(c)}/contacts/${encodeSegment(reqString(a, 'contactId'), 'contactId')}` }),
  },
  {
    name: 'marketsharp_contacts_search',
    tier: 'read',
    description: 'Find contacts by name, business, email, phone or address (MarketSharp QuickFind).' + EMPLOYEE_NOTE,
    inputSchema: { type: 'object', properties: { ...searchProps } },
    build: (a, c) => ({ method: 'POST', path: `${company(c)}/contacts/search`, body: searchBody(a) }),
  },
  {
    name: 'marketsharp_contacts_list',
    tier: 'read',
    description:
      'List contacts page by page, optionally only those changed since a date or with appointments in a date range or for one salesperson.',
    inputSchema: {
      type: 'object',
      properties: {
        modifiedSince: s(`Only contacts changed on or after this time. ${DATE_HINT}`),
        appointmentFrom: s(`Only contacts with an appointment on or after this time. ${DATE_HINT}`),
        appointmentTo: s(`Only contacts with an appointment on or before this time. ${DATE_HINT}`),
        salespersonId: s('Only contacts with appointments for this salesperson (employee ID).'),
        ...pagingProps,
      },
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/contacts/filter`,
      body: compact({
        start_modified_datetime: optString(a, 'modifiedSince', 40),
        start_appointment_datetime: optString(a, 'appointmentFrom', 40),
        end_appointment_datetime: optString(a, 'appointmentTo', 40),
        appointment_salesperson_id: optString(a, 'salespersonId', 64),
        pageNumber: optInt(a, 'pageNumber', 1, 100000) ?? 1,
        rowsPerPage: optInt(a, 'rowsPerPage', 1, 1000) ?? DEFAULT_ROWS,
      }),
    }),
  },
  // -------------------------------------------------------------- inquiries
  {
    name: 'marketsharp_inquiries_get',
    tier: 'read',
    description:
      'Get one inquiry (lead) by ID: date, status, lead sources, product interests, address and notes.',
    inputSchema: { type: 'object', properties: { inquiryId: s('MarketSharp inquiry ID.') }, required: ['inquiryId'] },
    build: (a, c) => ({ method: 'GET', path: `${company(c)}/inquiries/${encodeSegment(reqString(a, 'inquiryId'), 'inquiryId')}` }),
  },
  {
    name: 'marketsharp_inquiries_list',
    tier: 'read',
    description:
      'List inquiries (leads) page by page, optionally only those changed in a date range, with appointments in a date range, or for one salesperson.',
    inputSchema: {
      type: 'object',
      properties: {
        modifiedFrom: s(`Only inquiries changed on or after this time. ${DATE_HINT}`),
        modifiedTo: s(`Only inquiries changed on or before this time. ${DATE_HINT}`),
        appointmentFrom: s(`Only inquiries with an appointment on or after this time. ${DATE_HINT}`),
        appointmentTo: s(`Only inquiries with an appointment on or before this time. ${DATE_HINT}`),
        salespersonId: s('Only inquiries with appointments for this salesperson (employee ID).'),
        appointmentRequired: b('Only inquiries that have an appointment.'),
        ...pagingProps,
      },
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/inquiries/filter`,
      query: { isAppointmentRequired: optBool(a, 'appointmentRequired') },
      body: compact({
        start_modified_datetime: optString(a, 'modifiedFrom', 40),
        end_modified_datetime: optString(a, 'modifiedTo', 40),
        start_appointment_datetime: optString(a, 'appointmentFrom', 40),
        end_appointment_datetime: optString(a, 'appointmentTo', 40),
        appointment_salesperson_id: optString(a, 'salespersonId', 64),
        pageNumber: optInt(a, 'pageNumber', 1, 100000) ?? 1,
        rowsPerPage: optInt(a, 'rowsPerPage', 1, 1000) ?? DEFAULT_ROWS,
      }),
    }),
  },
  {
    name: 'marketsharp_inquiries_search',
    tier: 'read',
    description: "Find inquiries (leads) by the contact's name, business, email, phone or the inquiry address (QuickFind)." + EMPLOYEE_NOTE,
    inputSchema: { type: 'object', properties: { ...searchProps } },
    build: (a, c) => ({ method: 'POST', path: `${company(c)}/inquiries/search`, body: searchBody(a) }),
  },
  {
    name: 'marketsharp_inquiries_list_by_contact',
    tier: 'read',
    description: 'List every inquiry (lead) for one contact.',
    inputSchema: { type: 'object', properties: { contactId: s('MarketSharp contact ID.') }, required: ['contactId'] },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/contacts/${encodeSegment(reqString(a, 'contactId'), 'contactId')}/inquiries`,
    }),
  },
  {
    name: 'marketsharp_inquiry_statuses_list',
    tier: 'read',
    description: "List the company's inquiry (lead) statuses.",
    inputSchema: { type: 'object', properties: { includeInactive: b('Include statuses that are turned off.') } },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/inquiries/statuses`,
      query: { includeInactive: optBool(a, 'includeInactive') },
    }),
  },
  {
    name: 'marketsharp_inquiry_notes_list',
    tier: 'read',
    description: 'List the notes on an inquiry (lead), or on the job created from it.',
    inputSchema: {
      type: 'object',
      properties: {
        inquiryId: s('MarketSharp inquiry ID.'),
        noteType: s('Inquiry notes (default) or Job notes.', { enum: ['Inquiry', 'Job'] }),
      },
      required: ['inquiryId'],
    },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/opportunities/${encodeSegment(reqString(a, 'inquiryId'), 'inquiryId')}/notes/${
        optEnum(a, 'noteType', ['Inquiry', 'Job'] as const) ?? 'Inquiry'
      }`,
    }),
  },
  // ----------------------------------------------------------- appointments
  {
    name: 'marketsharp_appointments_get',
    tier: 'read',
    description: 'Get one appointment by ID: time, salespeople, type, result and address.',
    inputSchema: { type: 'object', properties: { appointmentId: s('MarketSharp appointment ID.') }, required: ['appointmentId'] },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/appointments/${encodeSegment(reqString(a, 'appointmentId'), 'appointmentId')}`,
    }),
  },
  {
    name: 'marketsharp_appointments_list',
    tier: 'read',
    description:
      'List appointments page by page by appointment date range, change date range, salesperson or inquiry. Use this for "what\'s on the schedule".',
    inputSchema: {
      type: 'object',
      properties: {
        appointmentFrom: s(`Appointments on or after this time. ${DATE_HINT}`),
        appointmentTo: s(`Appointments on or before this time. ${DATE_HINT}`),
        modifiedFrom: s(`Only appointments changed on or after this time. ${DATE_HINT}`),
        modifiedTo: s(`Only appointments changed on or before this time. ${DATE_HINT}`),
        salespersonId: s('Only this salesperson (employee ID).'),
        inquiryIds: { type: 'array', items: { type: 'string' }, description: 'Only appointments for these inquiry IDs.' },
        ...pagingProps,
      },
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/appointments/filter`,
      body: compact({
        start_appointment_datetime: optString(a, 'appointmentFrom', 40),
        end_appointment_datetime: optString(a, 'appointmentTo', 40),
        start_modified_datetime: optString(a, 'modifiedFrom', 40),
        end_modified_datetime: optString(a, 'modifiedTo', 40),
        appointment_salesperson_id: optString(a, 'salespersonId', 64),
        inquiry_ids: optStringArray(a, 'inquiryIds'),
        pageNumber: optInt(a, 'pageNumber', 1, 100000) ?? 1,
        rowsPerPage: optInt(a, 'rowsPerPage', 1, 1000) ?? DEFAULT_ROWS,
      }),
    }),
  },
  {
    name: 'marketsharp_appointments_list_by_contact',
    tier: 'read',
    description: 'List every appointment for one contact.',
    inputSchema: { type: 'object', properties: { contactId: s('MarketSharp contact ID.') }, required: ['contactId'] },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/appointments/contacts/${encodeSegment(reqString(a, 'contactId'), 'contactId')}`,
    }),
  },
  {
    name: 'marketsharp_appointment_results_list',
    tier: 'read',
    description: "List the company's active appointment results (e.g. Sold, No Sale), or the result reasons.",
    inputSchema: { type: 'object', properties: { reasons: b('List result reasons instead of results.') } },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/appointments/${optBool(a, 'reasons') ? 'resultreasons' : 'results'}/active`,
    }),
  },
  // ------------------------------------------------------------------- jobs
  {
    name: 'marketsharp_jobs_get',
    tier: 'read',
    description: 'Get one job by ID: name, type, status, site address, sale and completion dates, and contract total.',
    inputSchema: { type: 'object', properties: { jobId: s('MarketSharp job ID.') }, required: ['jobId'] },
    build: (a, c) => ({ method: 'GET', path: `${company(c)}/jobs/${encodeSegment(reqString(a, 'jobId'), 'jobId')}` }),
  },
  {
    name: 'marketsharp_jobs_search',
    tier: 'read',
    description: "Find jobs by job name or number, or by the contact's name, business, email, phone or address (QuickFind)." + EMPLOYEE_NOTE,
    inputSchema: {
      type: 'object',
      properties: { job_name: s('Job name.'), job_number: s('Job number.'), ...searchProps },
    },
    build: (a, c) => ({ method: 'POST', path: `${company(c)}/jobs/search`, body: searchBody(a, ['job_name', 'job_number']) }),
  },
  {
    name: 'marketsharp_opportunities_list',
    tier: 'read',
    description:
      'List opportunities (jobs and leads) changed since a date, with job numbers, sale and contract dates, contract totals, contract status and balance due.',
    inputSchema: {
      type: 'object',
      properties: {
        fromDate: s(`Only jobs and leads changed on or after this date. ${DATE_HINT}`),
        numberOfRecords: i('Most records to return (default 100).', 1, 1000),
      },
      required: ['fromDate'],
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/jobs/opportunities`,
      body: { fromDate: reqString(a, 'fromDate', 40), numberOfRecords: optInt(a, 'numberOfRecords', 1, 1000) ?? 100 },
    }),
  },
  // ------------------------------------------------------------------ notes
  {
    name: 'marketsharp_notes_list',
    tier: 'read',
    description: 'List the notes for a contact: all types, or one type such as ContactNote, Appointment, Inquiry or Job.' + EMPLOYEE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: s('MarketSharp contact ID.'),
        noteType: s('Only this note type.', { enum: [...NOTE_TYPES] }),
      },
      required: ['contactId'],
    },
    build: (a, c) => {
      const contact = encodeSegment(reqString(a, 'contactId'), 'contactId');
      const type = optEnum(a, 'noteType', NOTE_TYPES);
      return {
        method: 'GET',
        path: type ? `${company(c)}/notes/notetype/${type}/contact/${contact}` : `${company(c)}/notes/contact/${contact}`,
      };
    },
  },
  // ------------------------------------------------------- reference lists
  {
    name: 'marketsharp_activity_types_list',
    tier: 'read',
    description: "List the company's activity types (e.g. Call, Email, Follow Up). Use the description as activityType when creating an activity.",
    inputSchema: { type: 'object', properties: { includeInactive: b('Include activity types that are turned off.') } },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/activities/types`,
      query: { includeInactive: optBool(a, 'includeInactive') },
    }),
  },
  {
    name: 'marketsharp_employees_list',
    tier: 'read',
    description: 'List employees (salespeople, project managers and staff) with their IDs, page by page.',
    inputSchema: {
      type: 'object',
      properties: {
        search: s('Only employees whose name matches this text.'),
        activeOnly: b('Only active employees (default true).'),
        page: i('Page to return, starting at 1.', 1, 10000),
        pageSize: i('Employees per page (default 100).', 1, 500),
      },
    },
    build: (a, c) => ({
      method: 'GET',
      path: `${company(c)}/employees`,
      query: {
        s: optString(a, 'search', 100),
        isActiveOnly: optBool(a, 'activeOnly') ?? true,
        page: optInt(a, 'page', 1, 10000) ?? 1,
        pageSize: optInt(a, 'pageSize', 1, 500) ?? 100,
      },
    }),
  },
  {
    name: 'marketsharp_lead_sources_list',
    tier: 'read',
    description: "List the company's primary lead sources, or the secondary lead sources under one primary source.",
    inputSchema: {
      type: 'object',
      properties: {
        primaryLeadSourceId: s('List the secondary sources under this primary lead source.'),
        includeInactive: b('Include lead sources that are turned off.'),
      },
    },
    build: (a, c) => {
      const primary = optString(a, 'primaryLeadSourceId', 64);
      const suffix = optBool(a, 'includeInactive') ? '' : '/active';
      return {
        method: 'GET',
        path: primary
          ? `${company(c)}/primaryleadsources/${encodeSegment(primary, 'primaryLeadSourceId')}/secondaryleadsources${suffix}`
          : `${company(c)}/primaryleadsources${suffix}`,
      };
    },
  },
  {
    name: 'marketsharp_product_interests_list',
    tier: 'read',
    description: "List the company's product interests (e.g. Windows, Siding), or the ones attached to one inquiry (lead).",
    inputSchema: {
      type: 'object',
      properties: {
        inquiryId: s("List this inquiry's product interests instead of the company list."),
        includeInactive: b('Include product interests that are turned off (company list only).'),
      },
    },
    build: (a, c) => {
      const inquiry = optString(a, 'inquiryId', 64);
      return {
        method: 'GET',
        path: inquiry
          ? `${company(c)}/products/interests/leads/${encodeSegment(inquiry, 'inquiryId')}`
          : `${company(c)}/products/interests/${optBool(a, 'includeInactive') ? 'false' : 'true'}`,
      };
    },
  },
  {
    name: 'marketsharp_divisions_list',
    tier: 'read',
    description: "List the company's divisions.",
    inputSchema: { type: 'object', properties: {} },
    build: (_a, c) => ({ method: 'GET', path: `${company(c)}/divisions` }),
  },
  // ----------------------------------------------------------------- writes
  {
    name: 'marketsharp_contact_notes_create',
    tier: 'write',
    description: 'Add a new note to a contact. It never edits or removes an existing note.' + EMPLOYEE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: s('MarketSharp contact ID.'),
        note: s('Note text.'),
        employeeId: s("Employee the note is from. Defaults to the connection's Employee ID."),
      },
      required: ['contactId', 'note'],
    },
    build: (a, c) => {
      const employeeId = optString(a, 'employeeId', 64) ?? c.employeeId;
      if (!employeeId) {
        throw new MarketSharpApiError('employeeId is required: this connection has no Employee ID, so name the employee the note is from.');
      }
      return {
        method: 'POST',
        path: `${company(c)}/notes/contactNote`,
        // No `id`: MarketSharp's endpoint is an upsert, and omitting the id is what makes this create-only.
        body: { contactId: reqString(a, 'contactId', 64), note: reqString(a, 'note', 8000), employeeId, isActive: true },
      };
    },
  },
  {
    name: 'marketsharp_inquiry_notes_create',
    tier: 'write',
    description: 'Add a new note to an inquiry (lead), or to the job created from it. It never edits or removes an existing note.',
    inputSchema: {
      type: 'object',
      properties: {
        inquiryId: s('MarketSharp inquiry ID.'),
        note: s('Note text.'),
        noteType: s('Inquiry note (default) or Job note.', { enum: ['Inquiry', 'Job'] }),
      },
      required: ['inquiryId', 'note'],
    },
    build: (a, c) => ({
      method: 'POST',
      path: `${company(c)}/opportunities/notes`,
      // No `id`: omitting it makes MarketSharp insert rather than update.
      body: {
        inquiryId: reqString(a, 'inquiryId', 64),
        note: reqString(a, 'note', 8000),
        opportunityNoteType: optEnum(a, 'noteType', ['Inquiry', 'Job'] as const) ?? 'Inquiry',
      },
    }),
  },
  {
    name: 'marketsharp_activities_create',
    tier: 'write',
    description:
      'Create a new activity (to-do, call or follow-up) on a contact, optionally tied to an inquiry, appointment or job. MarketSharp automation rules do not run for activities created this way. It never edits an existing activity.' + EMPLOYEE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: s('MarketSharp contact ID.'),
        activityType: s('Activity type, as listed by marketsharp_activity_types_list.'),
        name: s('Short title.'),
        note: s('Details.'),
        assignedEmployeeId: s('Employee the activity is assigned to.'),
        dueDate: s(`When it is due. ${DATE_HINT}`),
        reminderMinutes: i('Remind the assignee this many minutes before it is due.', 0, 100000),
        inquiryId: s('Inquiry to tie it to.'),
        appointmentId: s('Appointment to tie it to.'),
        jobId: s('Job to tie it to.'),
      },
      required: ['contactId', 'activityType', 'assignedEmployeeId'],
    },
    build: (a, c) => {
      const reminder = optInt(a, 'reminderMinutes', 0, 100000);
      return {
        method: 'POST',
        path: `${company(c)}/activities`,
        // No activityId: omitting it makes MarketSharp insert rather than update.
        body: compact({
          contactId: reqString(a, 'contactId', 64),
          activityType: reqString(a, 'activityType', 200),
          name: optString(a, 'name', 200),
          note: optString(a, 'note', 8000),
          assignedEmployeeId: reqString(a, 'assignedEmployeeId', 64),
          scheduledEmployeeId: c.employeeId,
          dueDate: optString(a, 'dueDate', 40),
          reminderMinutes: reminder === undefined ? undefined : String(reminder),
          inquiryId: optString(a, 'inquiryId', 64),
          appointmentId: optString(a, 'appointmentId', 64),
          jobId: optString(a, 'jobId', 64),
          isActive: true,
        }),
      };
    },
  },
  {
    name: 'marketsharp_appointments_create',
    tier: 'write',
    description:
      "Book a new appointment on an existing inquiry (lead). The inquiry's address and notes are kept as they are. It doesn't change an existing appointment or record its result.",
    inputSchema: {
      type: 'object',
      properties: {
        inquiryId: s('MarketSharp inquiry ID to book the appointment on.'),
        appointmentDateTime: s(`Appointment start. ${DATE_HINT}`),
        salespersonId: s('Salesperson (employee ID) running the appointment.'),
        secondSalespersonId: s('Optional second salesperson (employee ID).'),
        appointmentType: s('Appointment type, if the company uses them.'),
        notes: s('Appointment notes.'),
      },
      required: ['inquiryId', 'appointmentDateTime', 'salespersonId'],
    },
    // MarketSharp's appointment save also rewrites the inquiry's address and
    // notes, blanking any field we omit. So read the inquiry first and send
    // its current values back unchanged.
    run: async (a, c) => {
      const inquiryId = reqString(a, 'inquiryId', 64);
      const appointmentDateTime = reqString(a, 'appointmentDateTime', 40);
      const salespersonOneId = reqString(a, 'salespersonId', 64);
      const inquiryText = await marketsharpRequest(c, {
        method: 'GET',
        path: `${company(c)}/inquiries/${encodeSegment(inquiryId, 'inquiryId')}`,
      });
      const inq = unwrapRecord(inquiryText);
      const contactId = inq && typeof inq.contactId === 'string' ? inq.contactId : undefined;
      if (!inq || !contactId) {
        throw new MarketSharpApiError(
          "Couldn't read that inquiry's contact and address, so no appointment was booked (booking without them would blank the inquiry's address)."
        );
      }
      const str = (k: string) => (typeof inq[k] === 'string' ? (inq[k] as string) : inq[k] == null ? '' : String(inq[k]));
      const body = compact({
        contactId,
        inquiryId,
        appointmentDateTime,
        salespersonOneId,
        salespersonTwoId: optString(a, 'secondSalespersonId', 64),
        appointmentType: optString(a, 'appointmentType', 100),
        appointmentNotes: optString(a, 'notes', 8000),
        appointmentSetById: c.employeeId,
        inquiryNotes: str('notes'),
        inquiryAddressLineOne: str('addressLineOne'),
        inquiryAddressLineTwo: str('addressLineTwo'),
        inquiryCity: str('city'),
        inquiryState: str('state'),
        inquiryZip: str('zip'),
        inquiryAddressLatitude: str('latitude'),
        inquiryAddressLongitude: str('longitude'),
      });
      return marketsharpRequest(c, { method: 'POST', path: `${company(c)}/appointments`, body });
    },
  },
];
