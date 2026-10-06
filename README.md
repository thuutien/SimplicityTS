# SimplicityTS

A simple ticket system with three roles: **employee**, **agent** and **admin**.

## Run

```
npm install
npm start
```

Open http://localhost:3000. Requires Node 22.13+ (uses the built-in `node:sqlite`).

## First admin account

On first run (empty database) one admin account is created. Set it up in `.env` before the first start:

```
ADMIN_EMAIL=you@yourcompany.com
ADMIN_PASSWORD=choose-a-strong-password
```

If `ADMIN_PASSWORD` is not set, a random password is generated and printed once in the server console.
Log in with it and change it under **My account**.

## Roles

| Action                              | Employee       | Agent | Admin |
|-------------------------------------|----------------|-------|-------|
| Create tickets                      | ✅             | ✅    | ✅    |
| View tickets                        | Own only       | All   | All   |
| Comment                             | On own tickets | Own dept | Any |
| Close ticket                        | Own only       | Own dept | Any |
| Change status / priority / dept / assignee | ❌      | Own dept | ✅ |
| Delete tickets                      | ❌             | ❌    | ✅    |
| Add / edit / delete users           | ❌             | ❌    | ✅    |

## Departments

There are two departments: **IT Support** and **Production**. Every ticket belongs to one, chosen when it is
created. Admins can put each agent in a department. Agents can see all tickets, but can only work on
(update, assign, comment on) tickets in their own department; other tickets are read-only for them.
Tickets can be assigned to admins or to agents in the ticket's department. Deleting a user is a soft delete: they can no longer
log in, their tickets and comments stay (shown as "Name (deleted)"), and their email can be reused.

## Accounts

- **Sign up:** anyone with an email at `ALLOWED_SIGNUP_DOMAIN` (set in `.env`) can create an account (first name, last name, email,
  password). They get a verification email and can log in once they click the link. New sign-ups are
  always employees; an admin can change their role.
- **My account:** everyone can change their name and password. Only admins can change a user's email (Users page).
- **Forgot password:** on the login page; sends a reset link that works once and expires after 30 minutes.
- **New tickets:** choose a Request Type. "Production Request" (Location, Request: Work Cart / Empty Cart / RMA / Tech Issue, optional Additional Info) goes to Production; "Report Issue to IT" (Location, Issue Description) goes to IT Support. The title is generated automatically and priority starts at Medium.
- **Admins** can create users with any email (no verification needed), edit them, set a password, or send them a reset link.
- Passwords must be at least 8 characters. Changing or resetting a password signs the user out on other devices.

## Email

Copy `.env.example` to `.env` and fill in your SMTP details (see the comments in that file for Gmail).
Restart the server after changing it. Without SMTP settings, emails are printed to the server console.

| Event | Who gets an email |
|---|---|
| Ticket created | Agents in the ticket's department (admins if the department has no agents) |
| Ticket assigned | The new assignee |
| Status changed | The person who created the ticket |
| Comment by staff | The ticket creator (and assignee) |
| Comment by the creator | The assignee, or the department's agents if unassigned |
| Ticket moved to another department | That department's agents |

Nobody is emailed about their own actions. Every email is logged in the `email_outbox` table; failed sends are retried up to 5 times.

Set `APP_URL` in `.env` to the address people use to reach the app (e.g. `http://192.168.1.50:3000`)
so links in emails work.

Data is stored in `tickets.db` (SQLite), including login sessions, so logins survive restarts.
