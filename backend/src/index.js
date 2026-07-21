import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import prisma from "./lib/prisma.js";

const app = express();
// PostgreSQL on this machine uses 5000, so the API uses 5001 by default.
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-development-secret";
const APP_URL = process.env.APP_URL || "http://localhost:5173";
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;

app.use(cors());
app.use(express.json());

const safeUser = ({ passwordHash, ...user }) => user;
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const tokenFor = (user) => jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
const verificationCode = () => String(Math.floor(100000 + Math.random() * 900000));

async function sendEmail({ to, subject, html }) {
  if (!mailer) return false;
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
    return true;
  } catch (error) {
    console.error("Email notification could not be sent:", error.message);
    return false;
  }
}

async function notifyGroupMembers(groupId, excludedUserId, subject, html) {
  const members = await prisma.groupMember.findMany({ where: { groupId, ...(excludedUserId ? { userId: { not: excludedUserId } } : {}) }, include: { user: { select: { email: true } } } });
  await Promise.all(members.map(({ user }) => sendEmail({ to: user.email, subject, html })));
}

async function sendVerificationCode(user) {
  const code = verificationCode();
  await prisma.user.update({ where: { id: user.id }, data: { verificationCodeHash: await bcrypt.hash(code, 10), verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
  const emailSent = await sendEmail({ to: user.email, subject: "Your SubSplit verification code", html: `<h2>Verify your email</h2><p>Use this code to finish creating your SubSplit account:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not create this account, you can ignore this email.</p>` });
  return emailSent;
}

async function sendPasswordResetCode(user) {
  const code = verificationCode();
  await prisma.user.update({ where: { id: user.id }, data: { passwordResetCodeHash: await bcrypt.hash(code, 10), passwordResetCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
  const emailSent = await sendEmail({ to: user.email, subject: "Your SubSplit password reset code", html: `<h2>Reset your password</h2><p>Use this code to set a new SubSplit password:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>` });
  return emailSent;
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Authentication required" });
  try {
    req.userId = jwt.verify(header.slice(7), JWT_SECRET).userId;
    next();
  } catch {
    res.status(401).json({ message: "Your session has expired. Please log in again." });
  }
}

async function membership(groupId, userId) {
  return prisma.groupMember.findUnique({ where: { userId_groupId: { userId, groupId } } });
}

async function ownerOnly(req, res, next) {
  const member = await membership(req.params.id || req.params.groupId, req.userId);
  if (!member || member.role !== "OWNER") return res.status(403).json({ message: "Only the group owner can do this" });
  req.membership = member;
  next();
}

function buildShares(totalCost, splitType, shares, memberIds) {
  const total = round(totalCost);
  if (!Array.isArray(shares) || !shares.length) throw new Error("Select at least one member for the split");
  const ids = shares.map((share) => share.userId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !memberIds.includes(id))) throw new Error("Every share must belong to a group member");
  if (splitType === "EQUAL") {
    const base = round(total / shares.length);
    return shares.map((share, index) => ({ userId: share.userId, amount: index === shares.length - 1 ? round(total - base * index) : base }));
  }
  if (splitType === "PERCENTAGE") {
    const percentageTotal = round(shares.reduce((sum, share) => sum + Number(share.percentage || 0), 0));
    if (percentageTotal !== 100) throw new Error("Percentages must add up to 100%");
    return shares.map((share) => ({ userId: share.userId, percentage: Number(share.percentage), amount: round(total * Number(share.percentage) / 100) }));
  }
  const amountTotal = round(shares.reduce((sum, share) => sum + Number(share.amount || 0), 0));
  if (amountTotal !== total) throw new Error("Custom amounts must equal the subscription cost");
  return shares.map((share) => ({ userId: share.userId, amount: round(share.amount) }));
}

async function groupBalances(groupId) {
  const [members, subscriptions, payments] = await Promise.all([
    prisma.groupMember.findMany({ where: { groupId }, include: { user: { select: { id: true, name: true, email: true } } } }),
    prisma.subscription.findMany({ where: { groupId, status: "ACTIVE" }, include: { shares: true } }),
    prisma.payment.findMany({ where: { groupId, status: "PAID" } }),
  ]);
  const totals = Object.fromEntries(members.map(({ user }) => [user.id, 0]));
  subscriptions.forEach((subscription) => {
    totals[subscription.payerId] += Number(subscription.totalCost);
    subscription.shares.forEach((share) => { totals[share.userId] -= Number(share.amount); });
  });
  payments.forEach((payment) => {
    totals[payment.debtorId] += Number(payment.amount);
    totals[payment.creditorId] -= Number(payment.amount);
  });
  const creditors = Object.entries(totals).filter(([, amount]) => amount > 0.009).map(([id, amount]) => ({ id, amount: round(amount) }));
  const debtors = Object.entries(totals).filter(([, amount]) => amount < -0.009).map(([id, amount]) => ({ id, amount: round(-amount) }));
  const settlements = [];
  while (creditors.length && debtors.length) {
    const creditor = creditors[0]; const debtor = debtors[0]; const amount = round(Math.min(creditor.amount, debtor.amount));
    settlements.push({ fromUserId: debtor.id, toUserId: creditor.id, amount });
    creditor.amount = round(creditor.amount - amount); debtor.amount = round(debtor.amount - amount);
    if (creditor.amount < 0.01) creditors.shift();
    if (debtor.amount < 0.01) debtors.shift();
  }
  const users = Object.fromEntries(members.map(({ user }) => [user.id, user]));
  return { balances: Object.entries(totals).map(([userId, amount]) => ({ user: users[userId], amount: round(amount) })), settlements: settlements.map((item) => ({ ...item, from: users[item.fromUserId], to: users[item.toUserId] })) };
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", message: "SubSplit API is running" }));

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) return res.status(400).json({ message: "Name, email, and a password of at least 6 characters are required" });
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) return res.status(409).json({ message: "An account already exists with this email" });
  const user = await prisma.user.create({ data: { name: name.trim(), email: normalizedEmail, passwordHash: await bcrypt.hash(password, 12) } });
  const emailSent = await sendVerificationCode(user);
  res.status(201).json({ requiresVerification: true, email: normalizedEmail, emailSent });
});

app.post("/api/auth/login", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email?.trim().toLowerCase() || "" } });
  if (!user || !(await bcrypt.compare(req.body.password || "", user.passwordHash))) return res.status(401).json({ message: "Incorrect email or password" });
  if (!user.emailVerifiedAt) return res.status(403).json({ message: "Verify your email before logging in", requiresVerification: true, email: user.email });
  res.json({ token: tokenFor(user), user: safeUser(user) });
});

app.post("/api/auth/verify-email", async (req, res) => {
  const { email, code } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email?.trim().toLowerCase() || "" } });
  if (!user || user.emailVerifiedAt || !user.verificationCodeHash || !user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) return res.status(400).json({ message: "This verification code is invalid or has expired" });
  if (!(await bcrypt.compare(String(code || ""), user.verificationCodeHash))) return res.status(400).json({ message: "Incorrect verification code" });
  const verifiedUser = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), verificationCodeHash: null, verificationCodeExpiresAt: null } });
  res.json({ token: tokenFor(verifiedUser), user: safeUser(verifiedUser) });
});

app.post("/api/auth/resend-verification", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email?.trim().toLowerCase() || "" } });
  if (!user || user.emailVerifiedAt) return res.status(400).json({ message: "A pending account was not found for this email" });
  const emailSent = await sendVerificationCode(user);
  res.json({ emailSent, message: emailSent ? "A new verification code was sent" : "SMTP is not configured, so the email could not be sent" });
});

app.post("/api/auth/request-password-reset", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email?.trim().toLowerCase() || "" } });
  if (!user) return res.status(404).json({ message: "An account with this email was not found" });
  const emailSent = await sendPasswordResetCode(user);
  res.json({ emailSent, message: emailSent ? "A reset code was sent to your email" : "SMTP is not configured, so the email could not be sent" });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { email, code, password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ message: "Your new password must be at least 6 characters" });
  const user = await prisma.user.findUnique({ where: { email: email?.trim().toLowerCase() || "" } });
  if (!user || !user.passwordResetCodeHash || !user.passwordResetCodeExpiresAt || user.passwordResetCodeExpiresAt < new Date()) return res.status(400).json({ message: "This reset code is invalid or has expired" });
  if (!(await bcrypt.compare(String(code || ""), user.passwordResetCodeHash))) return res.status(400).json({ message: "Incorrect reset code" });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12), passwordResetCodeHash: null, passwordResetCodeExpiresAt: null } });
  res.json({ message: "Password updated. You can now log in." });
});

app.get("/api/auth/profile", auth, async (req, res) => res.json(safeUser(await prisma.user.findUniqueOrThrow({ where: { id: req.userId } }))));

app.get("/api/groups", auth, async (req, res) => {
  const groups = await prisma.group.findMany({ where: { members: { some: { userId: req.userId } } }, include: { _count: { select: { members: true, subscriptions: { where: { status: "ACTIVE" } } } }, members: { where: { userId: req.userId }, select: { role: true } } }, orderBy: { updatedAt: "desc" } });
  res.json(groups.map(({ members, ...group }) => ({ ...group, role: members[0].role })));
});

app.post("/api/groups", auth, async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "A group name is required" });
  const group = await prisma.group.create({ data: { name: name.trim(), description: description?.trim() || null, creatorId: req.userId, members: { create: { userId: req.userId, role: "OWNER" } } } });
  res.status(201).json(group);
});

app.get("/api/groups/:id", auth, async (req, res) => {
  if (!await membership(req.params.id, req.userId)) return res.status(404).json({ message: "Group not found" });
  const group = await prisma.group.findUnique({ where: { id: req.params.id }, include: { members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { joinedAt: "asc" } }, subscriptions: { include: { payer: { select: { id: true, name: true } }, shares: true }, orderBy: { createdAt: "desc" } } } });
  res.json(group);
});

app.put("/api/groups/:id", auth, ownerOnly, async (req, res) => res.json(await prisma.group.update({ where: { id: req.params.id }, data: { name: req.body.name?.trim(), description: req.body.description?.trim() || null } })));
app.delete("/api/groups/:id", auth, ownerOnly, async (req, res) => { await prisma.group.delete({ where: { id: req.params.id } }); res.status(204).end(); });
app.delete("/api/groups/:id/members/:userId", auth, ownerOnly, async (req, res) => { if (req.params.userId === req.userId) return res.status(400).json({ message: "The group owner cannot remove themselves" }); const member = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: req.params.userId, groupId: req.params.id } } }); if (!member) return res.status(404).json({ message: "Member not found" }); await prisma.groupMember.delete({ where: { id: member.id } }); res.status(204).end(); });

app.post("/api/groups/:id/invitations", auth, ownerOnly, async (req, res) => {
  const email = req.body.email?.trim().toLowerCase(); if (!email) return res.status(400).json({ message: "An email is required" });
  const invitation = await prisma.invitation.upsert({ where: { groupId_email: { groupId: req.params.id, email } }, update: { status: "PENDING", senderId: req.userId }, create: { groupId: req.params.id, email, senderId: req.userId } });
  const group = await prisma.group.findUniqueOrThrow({ where: { id: req.params.id }, include: { creator: { select: { name: true } } } });
  const emailSent = await sendEmail({ to: email, subject: `You're invited to ${group.name} on SubSplit`, html: `<h2>You're invited to ${group.name}</h2><p>${group.creator.name} invited you to share subscription costs in SubSplit.</p><p>Sign in or create an account with this email, then accept the invitation from your dashboard.</p><p><a href="${APP_URL}">Open SubSplit</a></p>` });
  res.status(201).json({ ...invitation, emailSent });
});

app.get("/api/invitations", auth, async (req, res) => res.json(await prisma.invitation.findMany({ where: { email: (await prisma.user.findUniqueOrThrow({ where: { id: req.userId } })).email, status: "PENDING" }, include: { group: true, sender: { select: { name: true } } } })));
app.patch("/api/invitations/:id", auth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } }); const invitation = await prisma.invitation.findUnique({ where: { id: req.params.id } });
  if (!invitation || invitation.email !== user.email) return res.status(404).json({ message: "Invitation not found" });
  const status = req.body.status === "ACCEPTED" ? "ACCEPTED" : "DECLINED";
  await prisma.$transaction([prisma.invitation.update({ where: { id: invitation.id }, data: { status } }), ...(status === "ACCEPTED" ? [prisma.groupMember.upsert({ where: { userId_groupId: { userId: req.userId, groupId: invitation.groupId } }, update: {}, create: { userId: req.userId, groupId: invitation.groupId } })] : [])]);
  res.json({ status });
});

app.get("/api/subscriptions", auth, async (req, res) => {
  const where = { group: { members: { some: { userId: req.userId } } }, ...(req.query.groupId ? { groupId: req.query.groupId } : {}), ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.category ? { category: req.query.category } : {}), ...(req.query.search ? { name: { contains: req.query.search, mode: "insensitive" } } : {}) };
  res.json(await prisma.subscription.findMany({ where, include: { payer: { select: { id: true, name: true } }, group: { select: { id: true, name: true } }, shares: true }, orderBy: { createdAt: "desc" } }));
});

app.post("/api/subscriptions", auth, async (req, res) => {
  const { groupId, name, totalCost, currency = "USD", category = "OTHER", billingDay = 1, payerId, splitType = "EQUAL", shares } = req.body;
  const member = await membership(groupId, req.userId); if (!member) return res.status(403).json({ message: "You are not a member of this group" });
  if (!name?.trim() || !Number(totalCost) || !payerId) return res.status(400).json({ message: "Name, cost, and payer are required" });
  const groupMembers = await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
  const shareData = buildShares(totalCost, splitType, shares, groupMembers.map((item) => item.userId));
  const subscription = await prisma.subscription.create({ data: { groupId, name: name.trim(), totalCost: Number(totalCost), currency: currency.toUpperCase(), category, billingDay: Number(billingDay), payerId, splitType, shares: { create: shareData } }, include: { payer: { select: { id: true, name: true } }, shares: true } });
  await notifyGroupMembers(groupId, req.userId, `New subscription: ${subscription.name}`, `<h2>${subscription.name} was added</h2><p>${subscription.payer.name} added a ${currency.toUpperCase()} ${totalCost} monthly subscription to your shared group.</p><p><a href="${APP_URL}">Open SubSplit</a></p>`);
  res.status(201).json(subscription);
});

app.put("/api/subscriptions/:id", auth, async (req, res) => {
  const existing = await prisma.subscription.findFirst({ where: { id: req.params.id, group: { members: { some: { userId: req.userId } } } } });
  if (!existing) return res.status(404).json({ message: "Subscription not found" });
  const member = await membership(existing.groupId, req.userId); if (member.role !== "OWNER" && existing.payerId !== req.userId) return res.status(403).json({ message: "You can only edit subscriptions you pay" });
  const { shares, totalCost = existing.totalCost, splitType = existing.splitType, ...data } = req.body;
  const update = { ...data, totalCost: Number(totalCost), ...(shares ? { shares: { deleteMany: {}, create: buildShares(totalCost, splitType, shares, (await prisma.groupMember.findMany({ where: { groupId: existing.groupId }, select: { userId: true } })).map((item) => item.userId)) } } : {}) };
  res.json(await prisma.subscription.update({ where: { id: existing.id }, data: update, include: { payer: { select: { id: true, name: true } }, shares: true } }));
});

app.delete("/api/subscriptions/:id", auth, async (req, res) => { const item = await prisma.subscription.findFirst({ where: { id: req.params.id, group: { members: { some: { userId: req.userId } } } } }); if (!item) return res.status(404).json({ message: "Subscription not found" }); const member = await membership(item.groupId, req.userId); if (member.role !== "OWNER" && item.payerId !== req.userId) return res.status(403).json({ message: "You can only delete subscriptions you pay" }); await prisma.subscription.delete({ where: { id: item.id } }); res.status(204).end(); });
app.patch("/api/subscriptions/:id/cancel", auth, async (req, res) => { const item = await prisma.subscription.findFirst({ where: { id: req.params.id, group: { members: { some: { userId: req.userId } } } } }); if (!item) return res.status(404).json({ message: "Subscription not found" }); res.json(await prisma.subscription.update({ where: { id: item.id }, data: { status: "CANCELLED" } })); });

app.get("/api/payments", auth, async (req, res) => res.json(await prisma.payment.findMany({ where: { group: { members: { some: { userId: req.userId } } }, ...(req.query.groupId ? { groupId: req.query.groupId } : {}) }, include: { debtor: { select: { id: true, name: true } }, creditor: { select: { id: true, name: true } }, group: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } })));
app.post("/api/payments", auth, async (req, res) => { const { groupId, creditorId, amount, note } = req.body; if (!await membership(groupId, req.userId)) return res.status(403).json({ message: "You are not a group member" }); if (!creditorId || !Number(amount) || creditorId === req.userId) return res.status(400).json({ message: "Choose a recipient and valid amount" }); res.status(201).json(await prisma.payment.create({ data: { groupId, debtorId: req.userId, creditorId, amount: Number(amount), note } })); });
app.patch("/api/payments/:id", auth, async (req, res) => { const payment = await prisma.payment.findFirst({ where: { id: req.params.id, group: { members: { some: { userId: req.userId } } } }, include: { debtor: { select: { name: true } }, creditor: { select: { email: true, name: true } }, group: { select: { name: true } } } }); if (!payment) return res.status(404).json({ message: "Payment not found" }); if (payment.debtorId !== req.userId && payment.creditorId !== req.userId) return res.status(403).json({ message: "Not allowed" }); const status = ["PENDING", "PAID", "CANCELLED"].includes(req.body.status) ? req.body.status : payment.status; const updated = await prisma.payment.update({ where: { id: payment.id }, data: { status, paidAt: status === "PAID" ? new Date() : null } }); if (status === "PAID" && payment.status !== "PAID") await sendEmail({ to: payment.creditor.email, subject: `Payment marked as paid in ${payment.group.name}`, html: `<h2>Payment marked as paid</h2><p>${payment.debtor.name} marked a payment of ${payment.amount} ${payment.currency} as paid in ${payment.group.name}.</p><p><a href="${APP_URL}">View your balance</a></p>` }); res.json(updated); });

app.get("/api/wallet", auth, async (req, res) => { const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { walletBalance: true } }); const transactions = await prisma.walletTransaction.findMany({ where: { userId: req.userId }, orderBy: { createdAt: "desc" }, take: 20 }); res.json({ balance: user.walletBalance, transactions }); });
app.post("/api/wallet/top-up", auth, async (req, res) => { const amount = round(req.body.amount); if (!amount || amount <= 0) return res.status(400).json({ message: "Enter a valid demo top-up amount" }); const user = await prisma.user.update({ where: { id: req.userId }, data: { walletBalance: { increment: amount }, walletTransactions: { create: { type: "TOP_UP", amount, note: "Demo card top-up" } } }, select: { walletBalance: true } }); res.status(201).json({ balance: user.walletBalance, message: "Demo funds added successfully" }); });
app.post("/api/wallet/withdraw", auth, async (req, res) => { const amount = round(req.body.amount); const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { walletBalance: true } }); if (!amount || amount <= 0 || Number(user.walletBalance) < amount) return res.status(400).json({ message: "Insufficient demo balance" }); const updated = await prisma.user.update({ where: { id: req.userId }, data: { walletBalance: { decrement: amount }, walletTransactions: { create: { type: "WITHDRAWAL", amount, note: "Demo withdrawal" } } }, select: { walletBalance: true } }); res.json({ balance: updated.walletBalance, message: "Demo withdrawal completed" }); });
app.post("/api/payments/:id/pay-with-wallet", auth, async (req, res) => { const payment = await prisma.payment.findFirst({ where: { id: req.params.id, debtorId: req.userId, status: "PENDING" } }); if (!payment) return res.status(404).json({ message: "Pending payment not found" }); const result = await prisma.$transaction(async (tx) => { const debtor = await tx.user.findUniqueOrThrow({ where: { id: req.userId }, select: { walletBalance: true } }); if (Number(debtor.walletBalance) < Number(payment.amount)) throw new Error("Insufficient demo wallet balance"); await tx.user.update({ where: { id: req.userId }, data: { walletBalance: { decrement: payment.amount }, walletTransactions: { create: { type: "TRANSFER_OUT", amount: payment.amount, note: "Group settlement payment" } } } }); await tx.user.update({ where: { id: payment.creditorId }, data: { walletBalance: { increment: payment.amount }, walletTransactions: { create: { type: "TRANSFER_IN", amount: payment.amount, note: "Group settlement received" } } } }); return tx.payment.update({ where: { id: payment.id }, data: { status: "PAID", paidAt: new Date() } }); }); res.json({ payment: result, message: "Demo wallet payment completed" }); });

app.get("/api/reports/groups/:groupId/summary", auth, async (req, res) => { if (!await membership(req.params.groupId, req.userId)) return res.status(404).json({ message: "Group not found" }); res.json(await groupBalances(req.params.groupId)); });
app.get("/api/reports/dashboard", auth, async (req, res) => { const groups = await prisma.group.findMany({ where: { members: { some: { userId: req.userId } } }, select: { id: true } }); const groupIds = groups.map((group) => group.id); const results = await Promise.all(groups.map((group) => groupBalances(group.id))); const balance = round(results.reduce((sum, result) => sum + (result.balances.find((item) => item.user.id === req.userId)?.amount || 0), 0)); const activeSubscriptions = await prisma.subscription.count({ where: { status: "ACTIVE", groupId: { in: groupIds } } }); const monthlySpending = round((await prisma.expenseShare.aggregate({ where: { userId: req.userId, subscription: { status: "ACTIVE" } }, _sum: { amount: true } }))._sum.amount || 0); const [recentSubscriptions, recentPayments] = await Promise.all([prisma.subscription.findMany({ where: { groupId: { in: groupIds } }, include: { group: { select: { name: true } }, payer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 5 }), prisma.payment.findMany({ where: { groupId: { in: groupIds } }, include: { debtor: { select: { name: true } }, creditor: { select: { name: true } }, group: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 5 })]); res.json({ totalGroups: groups.length, activeSubscriptions, monthlySpending, amountOwed: Math.max(0, -balance), amountOwedToYou: Math.max(0, balance), recentSubscriptions, recentPayments }); });

app.use((error, _req, res, _next) => { console.error(error); res.status(error.code === "P2002" ? 409 : 400).json({ message: error.message || "Something went wrong" }); });
app.listen(PORT, () => console.log(`SubSplit API listening on http://localhost:${PORT}`));
