# Ledger — Secure Personal Finance Management Platform

Ledger is a personal finance management application designed to help users track income, expenses, savings, shared expenses, and monthly budgets in one place.

The platform is being built with a focus on **multi-user support, secure data separation, privacy-conscious financial document processing, and an intuitive conversational interface** for entering transactions.

## Features

###  Income & Expense Tracking

* Add income and expenses manually.
* Organize expenses into categories such as groceries, housing, transportation, subscriptions, and more.
* Automatically calculate total income, expenses, savings, and remaining balance.

###  Monthly Budget Dashboard

* View financial activity by month and year.
* Keep transactions associated with their actual transaction date.
* Prevent transactions from one month from being incorrectly merged into another month.

### Ledger Assistant

A conversational interface allows users to enter transactions without filling out traditional forms.
It then creates a transaction preview and adds the information to the appropriate Ledger section.

###  Bank Statement Import

* Import bank statements through CSV.
* Import supported PDF statements.
* Extract transaction information for review before adding it.
* Categorize transactions automatically where possible.
* Detect duplicate transactions before saving.

###  Receipt Processing

* Scan receipts using the device camera or upload an image.
* Extract relevant transaction information.
* Avoid storing unnecessary personal information from the receipt.

###  Shared / Split Expenses

Users can record an expense that was paid on behalf of multiple people.

Ledger records only the user's actual financial responsibility as their budget expense while tracking the remaining amount as money owed back to them.

### Authentication & Data Isolation

* Individual user accounts.
* Secure login and registration.
* Password reset functionality.
* Each user's transactions are associated with their own user ID.
* Database-level Row Level Security is used to prevent users from accessing another user's financial records.

###  Data Export

* Export transactions as CSV.
* Export an Excel-compatible spreadsheet.
* Import previously exported CSV data.

## Technology

### Frontend

* HTML5
* CSS3
* JavaScript

### Backend & Database

* Supabase
* PostgreSQL
* Supabase Authentication
* Row Level Security (RLS)

### Data Processing

* CSV parsing
* PDF transaction extraction
* Browser-based OCR for receipts
* Transaction normalization
* Duplicate detection

## Architecture

```text
User
  │
  ▼
Ledger Web Application
  │
  ├── Manual Entry
  ├── Ledger Assistant
  ├── Receipt Scanner
  └── Bank Statement Import
  │
  ▼
Authentication
  │
  ▼
Supabase
  │
  ├── PostgreSQL Database
  └── Row Level Security
  │
  ▼
User-specific Transactions
```

## Security & Privacy

Ledger is designed around the principle of collecting and storing only the financial information required for budgeting.

The database is intentionally designed to avoid storing unnecessary sensitive information such as:

* Full payment card numbers
* Bank account numbers
* Home addresses
* Raw receipt images
* Raw bank statement files

Uploaded financial documents should be processed only as necessary to extract transaction information, with temporary files deleted when they are no longer required.

Database access is protected through authenticated users and Row Level Security policies so that a customer can only access their own transactions.

> **Important:** This project is currently under development and should not be considered production-ready for real financial information until security, privacy, retention, authentication, and deployment controls have been fully reviewed.

## Database Structure

The main transaction record contains information such as:

```text
id
user_id
transaction_date
transaction_type
category
source
description
amount
gross_amount
user_share
reimbursement_due
is_split
created_at
```

Transactions are separated by:

**User ID** → determines who owns the transaction.

**Transaction date** → determines which month the transaction belongs to.

This prevents August and September transactions from being overwritten or accidentally merged.

## Project Goals

The long-term goal of Ledger is to become a secure, intelligent personal finance platform that combines:

* Automated transaction tracking
* Conversational financial data entry
* Bank statement processing
* Receipt recognition
* Shared expense tracking
* Personalized budgeting recommendations
* Secure multi-user financial data management

## Current Status

 **Active Development**

Current functionality includes:

* User authentication
* PostgreSQL transaction storage
* Row Level Security
* Manual income/expense entry
* Conversational transaction entry
* CSV imports
* Receipt OCR
* Monthly transaction filtering
* Duplicate detection
* Split expense tracking
* CSV/Excel export

## Author

**Maleha Isrta Chowdhury**

Computer Engineering / Computer Science
Canada

