export type Deal = {
  id: number;
  company_id: number;
  primary_contact_id: number | null;
  title: string;
  stage: string;
  situation: string | null;
  next_step: string | null;
  next_step_due: string | null;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
  company_name: string;
  company_domain: string | null;
  last_activity_at: string | null;
  fee_terms?: string | null;
  retainer?: number | null;
  success_fee_pct?: number | null;
  ebitda?: number | null;
  enterprise_value?: number | null;
  expected_close?: string | null;
  probability?: number | null;
};

export type TeamMember = { user_id: number; name: string; role: string };
export type UserOption = { id: number; name: string };

export type Task = {
  id: number;
  title: string;
  due: string | null;
  done: number;
  deal_id: number | null;
  contact_id: number | null;
  created_at: string;
  deal_title?: string | null;
  contact_first_name?: string | null;
  contact_last_name?: string | null;
};

export type CompanyOption = { id: number; name: string; domain: string | null };

export type DealOption = { id: number; title: string; company_name: string | null };
