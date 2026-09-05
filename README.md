Ledger — Secure Personal Finance Management Platform

Ledger is a personal finance management application designed 
to help users track income, expenses, savings, shared expenses, and monthly budgets in one place.
The platform is being built with a focus on multi-user support, secure data separation, 
privacy-conscious financial document processing, and an intuitive conversational interface for entering transactions.

1. Project flow
                         ┌─────────────────┐
                         │      USER       │
                         └────────┬────────┘
                                  │
                                  ▼
                      ┌─────────────────────┐
                      │ Login / Registration│
                      └──────────┬──────────┘
                                 │
                                 ▼
                    ┌───────────────────────┐
                    │   Ledger Dashboard    │
                    └───────────┬───────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ┌─────────────┐       ┌─────────────┐       ┌──────────────┐
   │Manual Entry │       │   Chatbot   │       │Bank Statement│
   └──────┬──────┘       └──────┬──────┘       └──────┬───────┘
          │                     │                     │
          └──────────────┬──────┴─────────────────────┘
                         ▼
               ┌────────────────────┐
               │ Transaction Parsing │
               └──────────┬─────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ Duplicate Check │
                 └────────┬────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ Supabase / SQL  │
                 │    Database     │
                 └────────┬────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
                August      September
                2026           2026
2. System architecture
┌──────────────────────────────────────────────┐
│                 FRONTEND                     │
│           HTML / CSS / JavaScript            │
│                                              │
│ Dashboard │ Chatbot │ Receipt │ Bank Import │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 AUTHENTICATION               │
│              Supabase Auth                   │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                  DATABASE                    │
│               PostgreSQL                     │
│                                              │
│   users → transactions → monthly records    │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ Row Level       │
              │ Security (RLS)  │
              └─────────────────┘
3. Database schema
┌──────────────────────┐
│       USERS          │
├──────────────────────┤
│ id (PK)              │
│ email                │
│ created_at           │
└──────────┬───────────┘
           │ 1
           │
           │ N
┌──────────▼───────────┐
│    TRANSACTIONS      │
├──────────────────────┤
│ id (PK)              │
│ user_id (FK)         │
│ transaction_date     │
│ transaction_type     │
│ category             │
│ source               │
│ description          │
│ amount               │
│ gross_amount         │
│ user_share           │
│ reimbursement_due    │
│ is_split             │
│ fingerprint          │
│ created_at           │
└──────────────────────┘

4. Feature table
Feature	Input	Processing	Output
Manual Entry	Date, category, amount	Validate → Save	Transaction
Chatbot	Natural conversation	Collect → Structure → Validate	Transaction
Receipt	Receipt image	OCR → Extract	Expense
Bank CSV	CSV statement	Parse → Categorize → Deduplicate	Transactions
Bank PDF	PDF statement	Extract → Parse → Review	Transactions
Split Expense	Total + user's share	Calculate remainder	Expense + reimbursement
Authentication	Email + password	Supabase Auth	User account
Monthly View	Month/year	Database filtering	Monthly dashboard

5. Split-expense logic
                    EXPENSE
                      │
                      ▼
                 Total = $60
                      │
              ┌───────┴────────┐
              ▼                ▼
        Your share          Other share
            $20                 $40
              │                  │
              ▼                  ▼
        Budget expense      Reimbursement
             $20                $40



6.Active Development

Current functionality includes:

User authentication
PostgreSQL transaction storage
Row Level Security
Manual income/expense entry
Conversational transaction entry
CSV imports
Receipt OCR
Monthly transaction filtering
Duplicate detection
Split expense tracking
CSV/Excel export


Author

Maleha Israt Chowdhury
Computer Engineering / Computer Science
Canada

