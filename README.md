# Ledger — Finance Management

Ledger is a personal finance management application that helps users track income, expenses, savings, shared expenses, savings goals, and monthly budgets in one place.

The platform is built with a focus on **multi-user support, secure data separation, and privacy-conscious financial document processing**: bank statements and receipt photos are read in the browser and are never uploaded.

## Features

### Income & Expense Tracking

* Add income and expenses manually, with an optional store name or note.
* Organize expenses into categories such as groceries, housing, transportation, subscriptions, and more. Each category counts as a Need, Want, or Savings.
* Automatically calculate total income, expenses, savings, and what is left in the account.

### Monthly Budget Dashboard

* View financial activity by month and year.
* Keep transactions associated with their actual transaction date, so one month is never merged into another.
* A **This month** card with a pie chart of needs, wants, and savings.
* Under the totals, a bar for Needs, Wants, and Savings shows dollars spent or saved against each target (for example "Wants: $195.99 of $967.50 · $771.51 left"), followed by a one-line verdict such as "Needs are $312.50 over".
* Targets default to 50 / 30 / 20 of income and can be changed under **Change targets**.

### Calendar

* Sits next to **This month** on the Budget tab.
* A month calendar with a green dot on each day with income, an orange dot on each day with expenses, and the amount spent that day.
* Tap a day to see its transactions; **Add expense** and **Add income** open the form with that date filled in.
* A **Year** view shows income, spending, and what was left for each month.

### Income Pattern Reminders

* Learns regular income (the same source arriving weekly, every two weeks, or monthly) and marks the next expected day on the calendar. The learned patterns are listed on the Goals tab.
* Around payday, the Budget tab asks "Did your paycheck arrive?" with a one-tap **Yes, add it**.
* Optional browser notifications. There is no push server, so they appear when Ledger is opened around payday.

### Bank Statement Import (PDF or CSV)

* Import text-based PDF statements or CSV exports; files are read locally in the browser.
* PDFs: reads the statement's **Withdrawals** and **Deposits** columns, so withdrawals become expenses and deposits become income. Statements without separate columns fall back to keywords, +/- signs, and the running balance.
* CSVs: works with a signed Amount column, separate Withdrawal/Deposit (Debit/Credit) columns, a Debit/Credit type column, or no header row at all.
* Budget-tracker spreadsheets saved as CSV also work: months across the top with Week 1 / Week 2 / Month Total columns, and separate EXPENSE and INCOME sections. Each filled week becomes one transaction, totals are skipped, and category names such as Rent, Grocery, or Credit Card are matched to Ledger's categories.
* If a file's layout isn't recognized, nothing is added and Ledger explains which layouts it can read.
* After an import, each transaction is saved in its own month. Ledger shows the latest imported month and lists the months that were added.
* Suggests a category for each transaction and shows a review table before anything is saved.
* Detects duplicates, so importing the same statement twice does not add transactions twice.

### Receipt Scanning

* Scan a receipt with the device camera or upload a photo; text recognition (OCR) runs in the browser.
* Fills in the receipt **total** and the **store name** from the top of the receipt.
* Lists the items on the receipt with a suggested category for each (for example groceries, personal care, health). Users can change any category or untick items, then add them as one expense per category. Tax is shared across the categories so they add up to the receipt total.
* The receipt image is never uploaded or stored.

### Shared / Split Expenses

* Mark an expense as **Shared** and enter the total amount paid and your share.
* Only your share counts as your spending; the rest is tracked as money owed back to you.
* **Got it back** records the repayment (full or partial) as income.
* "Left in account" still counts money paid on someone else's behalf, so it always matches the bank balance.

### Savings Goals & Sharing

* Create savings goals with a target amount and date.
* Each goal shows a plan: how much to save per month, whether recent leftover covers it, and which flexible category could close the gap.
* **Share** any goal by emailing an invite or copying an invite link. People who join can see the goal and add savings; only the owner can edit or delete it.
* Owners can remove people or turn off an invite link; members can leave a goal.

### Badges

* Earned for milestones such as a first entry, logging 7 days in a row, saving $100 and $1,000, staying within budget for a month, reaching a goal, and sharing a goal. Badges not earned yet are shown greyed out with what's left to do.

### Next-Month Forecast

* Predicted income, expenses, and remainder for next month.
* Starts with a baseline from recent months; with four or more months of history, a small neural network (TensorFlow.js) is trained in the browser.

### Ledger Assistant

* A floating assistant that answers questions such as "Can I afford $100?", "How can I save $500?", or "Where am I spending the most?" using the user's own Ledger data.
* Rule-based: nothing typed into it is sent to an AI service.

### Profile

* A profile sheet with the user's initial, name, email, and three numbers: left this month, saved in goals, and goals reached.
* Rename, change password, export data, import a bank statement, delete account, and log out.
* **Delete account** asks the user to type DELETE, then removes the account and all of its transactions and goals.

### Authentication & Data Isolation

* Individual user accounts with sign in, registration, and password reset.
* Clear messages for common problems, such as signing up with an email that already has an account.
* Each user's transactions and goals are tied to their user ID.
* Database-level Row Level Security prevents users from accessing another user's financial records. Shared goals are visible only to the owner and the people they share with.

### Data Export

* Export transactions as CSV.
* Export a PDF report for the selected month.

### Install as an App

* Includes a web app manifest and offline app shell, so Ledger can be installed from supported browsers when hosted over HTTPS.

## Technology

### Frontend

* HTML5, CSS3, JavaScript (single page, no build step)
* pdf.js — PDF statement reading
* Tesseract.js — receipt OCR
* TensorFlow.js — next-month forecast

### Backend & Database

* Supabase
* PostgreSQL
* Supabase Authentication
* Row Level Security (RLS)
* Supabase Edge Function (`invite-partner`) for goal invite emails

## Architecture

```text
User
  │
  ▼
Ledger Web Application (runs in the browser)
  │
  ├── Budget: manual entry, shared expenses, targets
  ├── Bank statement import (PDF, read locally)
  ├── Receipt scanner (OCR, read locally)
  ├── Goals: plans, forecast, sharing
  └── Ledger Assistant
  │
  ▼
Supabase Authentication
  │
  ▼
Supabase
  │
  ├── PostgreSQL + Row Level Security
  └── Edge Function: invite-partner (sends goal invite emails)
  │
  ▼
User-specific transactions and goals
```

## Security & Privacy

Ledger is designed around the principle of collecting and storing only the financial information required for budgeting.

The database intentionally does not store sensitive information such as:

* Full payment card numbers
* Bank account numbers
* Home addresses
* Receipt images
* Bank statement files

Bank statements and receipts are processed in the browser; only the extracted transaction fields are saved.

The page uses Supabase's **publishable** key, which is designed to be public. Database access is protected by authentication and Row Level Security policies. The Supabase secret key is used only inside the Edge Function and must never be added to the HTML.

> **Important:** This project is currently under development and should not be considered production-ready for real financial information until security, privacy, retention, authentication, and deployment controls have been fully reviewed.

## Database Structure

**transactions** — one row per income or expense:

```text
id
user_id
transaction_date
transaction_type      income | expense
category
source
description
amount                for shared expenses, the user's own share
fingerprint           duplicate detection
gross_amount          full amount paid (shared expenses)
user_share
reimbursement_due     amount still owed back
shared_expense
created_at
```

**savings_goals** — each user's goals (name, target amount, saved amount, target date, status).

**goal_members** — people a goal is shared with (by email).

**goal_invites** — invite link tokens, which the owner can turn off.

Database functions `join_goal` (join through an invite link) and `add_to_goal` (add savings as the owner or a member) enforce who can do what. `delete_my_account` lets signed-in users delete only their own account.

Transactions are separated by:

**User ID** → determines who owns the transaction.

**Transaction date** → determines which month the transaction belongs to.

This prevents August and September transactions from being overwritten or accidentally merged.

## Project Structure

```text
index.html                                   the app
Ledger-database-schema.sql                   full database setup for a new Supabase project
```

## Current Status

**Active Development**

Current functionality includes:

* User authentication, profile, and password reset
* PostgreSQL storage with Row Level Security
* Manual income and expense entry with store names and notes
* Monthly dashboard with a spending pie chart, target bars, and a one-line verdict
* Calendar with month and year views
* Income pattern reminders and optional notifications
* Badges
* PDF and CSV bank statement import (withdrawals and deposits)
* Receipt OCR with item categories
* Shared expenses with repayment tracking
* Savings goals with plans, sharing, and invite links
* Next-month forecast
* Ledger Assistant
* Duplicate detection
* CSV and PDF export

## Author

**Maleha Israt Chowdhury**

Computer Engineering / Computer Science
Canada
