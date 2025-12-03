import { Router } from 'itty-router';

// =========================================================
// 1. ENVIRONMENT & CONSTANTS
// =========================================================

export interface Env {
    BOT_TOKEN: string;
    KV_BINDING: KVNamespace;
}

const router = Router();
const ADMIN_LIST_KEY = "telegram_admin_ids";
const CHANNEL_ID_KEY = "target_channel_id";
const PAYMENT_AMOUNT_KEY = "payment_amount_etb";
const PAYMENT_PHONE_KEY = "payment_phone_number";
const USER_ID_LIST_KEY = "registered_user_ids";
const ADMIN_PENDING_PREFIX = "admin_pending_command:"; // Key prefix for admin state
const USER_STATE_PREFIX = "user_payment_state:";     // Key prefix for user state

// Payment State Constants
const STATE = {
    WAITING_FOR_PHONE: "WAITING_FOR_PHONE",
    PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
    PENDING_ADMIN_REVIEW: "PENDING_ADMIN_REVIEW",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
}

//  User-Facing Texts
const PROMPT_CONFIRM = `✅ Step 3: After steps 1 & 2, send /confirm_payment.`;
const PHONE_RECEIVED = "✅ Phone number received. Now press the button below to confirm.";
const INVALID_PHONE = "❌ Invalid phone number format. Please send numbers only.";
const ALREADY_APPROVED = "✅ You are already a member. Contact admin if you don't have the link.";
const PENDING_ADMIN_INITIAL_MESSAGE = `✨ Your payment is pending admin review. You will receive a single-use invite link soon.`;
const PENDING_ADMIN = `Phone number confirmed`;
const PAYMENT_APPROVED = "✅ Payment approved. Here is your single-use invite link.";
const PAYMENT_REJECTED = "❌ Your payment was not approved. Please contact an admin for the reason.";
const ACCESS_REVOKED = "⛔ Your access to the private channel has been revoked. To re-subscribe, use /start.";
const USER_STATUS_MESSAGE = "ℹ️ *Your Subscription Status:*";
const REGULAR_HELP = "👋 *GoldBot* registration assistant.\n\n*Commands:*\n• `/start` - Start registration\n• `/status` - Check your subscription status\n• `/help` - Show this message";

// =========================================================
// 1A. VALIDATION UTILITIES
// =========================================================

// Validates Ethiopian phone numbers (more strict)
function validateEthiopianPhone(phone: string): { valid: boolean; normalized?: string; error?: string } {
    const trimmed = phone.trim();

    // Pattern 1: +2519XXXXXXXX (international format)
    const intlPattern = /^\+2519\d{8}$/;
    // Pattern 2: 09XXXXXXXX (local format)
    const localPattern = /^09\d{8}$/;
    // Pattern 3: 2519XXXXXXXX (without +)
    const altIntlPattern = /^2519\d{8}$/;

    if (intlPattern.test(trimmed)) {
        return { valid: true, normalized: trimmed };
    } else if (localPattern.test(trimmed)) {
        // Normalize to international format
        return { valid: true, normalized: '+251' + trimmed.substring(1) };
    } else if (altIntlPattern.test(trimmed)) {
        // Add missing +
        return { valid: true, normalized: '+' + trimmed };
    }

    return {
        valid: false,
        error: "Invalid Ethiopian phone number. Use format: +2519XXXXXXXX or 09XXXXXXXX"
    };
}

// Validates Telegram Channel ID
function validateChannelId(channelId: string): { valid: boolean; error?: string } {
    const trimmed = channelId.trim();

    if (!/^-100\d{10,}$/.test(trimmed)) {
        return {
            valid: false,
            error: "Invalid Channel ID. Must start with -100 followed by at least 10 digits."
        };
    }

    return { valid: true };
}

// Validates payment amount
function validatePaymentAmount(amount: string): { valid: boolean; error?: string } {
    const trimmed = amount.trim();

    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
        return {
            valid: false,
            error: "Invalid amount. Use format: 100 or 99.99 (max 2 decimal places)"
        };
    }

    const numAmount = parseFloat(trimmed);
    if (numAmount <= 0) {
        return { valid: false, error: "Amount must be greater than 0" };
    }

    if (numAmount > 100000) {
        return { valid: false, error: "Amount exceeds maximum allowed (100,000 ETB)" };
    }

    return { valid: true };
}

// Validates Telegram User ID
function validateUserId(userId: string): { valid: boolean; error?: string } {
    const trimmed = userId.trim();

    if (!/^\d+$/.test(trimmed)) {
        return { valid: false, error: "Invalid User ID. Must be numeric." };
    }

    const numId = parseInt(trimmed, 10);
    if (numId <= 0) {
        return { valid: false, error: "User ID must be positive" };
    }

    return { valid: true };
}

// =========================================================
// 1B. ERROR HANDLING UTILITIES
// =========================================================

// Safely wraps KV operations with error handling
async function safeKVGet<T>(key: string, env: Env, defaultValue: T): Promise<T> {
    try {
        const value = await env.KV_BINDING.get(key);
        if (value === null) return defaultValue;
        return JSON.parse(value) as T;
    } catch (error) {
        console.error(`KV GET Error for key ${key}:`, error);
        return defaultValue;
    }
}

async function safeKVPut(key: string, value: any, env: Env, options?: any): Promise<boolean> {
    try {
        await env.KV_BINDING.put(key, JSON.stringify(value), options);
        return true;
    } catch (error) {
        console.error(`KV PUT Error for key ${key}:`, error);
        return false;
    }
}

// Safely wraps Telegram API calls
async function safeTelegramRequest(url: string, payload: any): Promise<any | null> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Telegram API Error: ${response.status} - ${errorText}`);
            return null;
        }

        const data = await response.json();
        if (!data.ok) {
            console.error(`Telegram API returned ok=false:`, data);
            return null;
        }

        return data.result;
    } catch (error) {
        console.error(`Telegram API Request Failed:`, error);
        return null;
    }
}

// Function to combine the  instructions
async function getFullInstructions(env: Env): Promise<string> {
    let paymentAmount = null;
    let paymentPhone = null;
    let errorLog = '';

    try {
        paymentAmount = await getPaymentAmount(env);
    } catch (e) {
        errorLog += `Failed to load payment amount. `;
    }

    try {
        paymentPhone = await getPaymentPhone(env);
    } catch (e) {
        errorLog += `Failed to load payment phone number. `;
    }

    let paymentInstruction = `💰 Step 1: Pay with Telebirr to: `;
    if (paymentAmount) {
        paymentInstruction += `\`${paymentAmount}\` ETB to `;
    }
    if (paymentPhone) {
        paymentInstruction += `📞 \`${paymentPhone}\``;
    } else {
        paymentInstruction += `an unset phone number. (Admin needs to set)`;
    }

    const promptPhoneInstruction = `📲 Step 2: *Now, please send the phone number you paid from.* Supported formats: \`+2519xxxxxxxx\` or \`09xxxxxxxx\`.`;

    const debugInfo = errorLog ? `\n\n[ADMIN DEBUG: ${errorLog}Please check bot configuration.]` : '';

    return `
👑✨ Gold Market - Registration ✨👑
Welcome! 👋
To get daily updates by joining our private channel, please:

${paymentInstruction}
${promptPhoneInstruction}
${PROMPT_CONFIRM}
${debugInfo}
`;
}


// =========================================================
// 2. TELEGRAM API HELPERS 
// =========================================================

// Helper function to send messages back to Telegram
// Helper to send messages back to Telegram
async function sendTelegramMessage(chat_id: number, text: string, env: Env, reply_markup?: any, parse_mode: string | undefined = 'Markdown'): Promise<boolean> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    const payload: any = {
        chat_id: chat_id,
        text: text,
    };

    if (parse_mode) {
        payload.parse_mode = parse_mode;
    }

    if (reply_markup) {
        payload.reply_markup = reply_markup;
    }

    const result = await safeTelegramRequest(url, payload);
    return result !== null;
}

// Helper to escape Markdown special characters (Legacy Markdown)
function escapeMarkdown(text: string): string {
    // Legacy Markdown only needs escaping for *, _, `, [
    return text.replace(/[*_`[]/g, '\\$&');
}

// Helper to edit an existing message (for cleaner UI navigation)
async function editTelegramMessage(chat_id: number, message_id: number, text: string, env: Env, reply_markup?: any): Promise<boolean> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
    const payload: any = {
        chat_id: chat_id,
        message_id: message_id,
        text: text,
        parse_mode: 'Markdown',
    };

    if (reply_markup) {
        payload.reply_markup = reply_markup;
    }

    const result = await safeTelegramRequest(url, payload);
    return result !== null;
}

// Helper to delete a message
async function deleteTelegramMessage(chat_id: number, message_id: number, env: Env): Promise<boolean> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`;
    const payload = {
        chat_id: chat_id,
        message_id: message_id
    };
    const result = await safeTelegramRequest(url, payload);
    return result !== null;
}

// Helper function to generate a single-use invite link
async function generateSingleUseInviteLink(channel_id: string, name: string, env: Env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`;

    const payload = {
        chat_id: channel_id,
        member_limit: 1,
        name: name
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (response.ok) {
        const result = await response.json();
        // Return the full object to store the link
        return result.result;
    } else {
        console.error('Failed to create invite link:', await response.text());
        return null;
    }
}

// Helper function to explicitly revoke (delete) a chat invite link
async function revokeChatInviteLink(channel_id: string, invite_link: string, env: Env): Promise<boolean> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/revokeChatInviteLink`;

    const payload = {
        chat_id: channel_id,
        invite_link: invite_link
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        // This is okay if the link was already consumed/deleted, but log for debug
        const errorText = await response.text();
        console.warn(`Failed to explicitly revoke link ${invite_link}: ${errorText}`);
        return false;
    }
    return true;
}


// Helper function to kick out (unban) a user from a chat/channel
async function unbanChatMember(channel_id: string, user_id: number, env: Env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/unbanChatMember`;

    // Setting only_if_banned: false ensures that if the user is a member, 
    // calling this acts as a 'kick'. They will need a new invite link to rejoin.
    const payload = {
        chat_id: channel_id,
        user_id: user_id,
        only_if_banned: false,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        // Log the error but don't fail the entire revocation, as state update is more critical
        console.error(`Failed to KICK user ${user_id} from ${channel_id}:`, await response.text());
        return false;
    }
    return true;
}

// Fetches display name from Telegram using the getChat API
async function getUserDisplayDetails(userId: number, env: Env): Promise<string> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChat`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId }),
    });

    if (response.ok) {
        const result = await response.json();
        const chat = result.result;

        // Prioritize username, then full name, then fallback
        let displayName = chat.username ? `@${chat.username}` : chat.first_name;
        if (chat.last_name && !chat.username) {
            displayName += ` ${chat.last_name}`;
        }

        return displayName || `Unknown User`;
    } else {
        return `[ID ${userId} - Details Unavailable]`;
    }
}

// Fetches a user's membership status in a specific chat/channel
async function getChatMember(channel_id: string, user_id: number, env: Env): Promise<{ status: string } | null> {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`;
    const payload = {
        chat_id: channel_id,
        user_id: user_id,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    let result;
    try {
        result = await response.json();
    } catch (e) {
        // This can happen if Telegram returns a non-JSON error (e.g., HTML error page).
        const responseBody = await response.text().catch(() => 'could not read body');
        console.error(`Failed to parse JSON from getChatMember for user ${user_id}. Status: ${response.status}. Body:`, responseBody);
        return null; // Failed to parse, can't determine status.
    }

    if (response.ok) {
        return result.result; // This is the ChatMember object.
    } else {
        // If the user isn't in the chat, Telegram API returns an error. A "user not found" error is expected.
        if (result && result.description && result.description.includes('user not found')) {
            return { status: 'not_found' }; // Indicates user is not in the group.
        }
        console.error(`API Error from getChatMember for user ${user_id} in channel ${channel_id}:`, result);
        return null; // On other unexpected errors.
    }
}

// =========================================================
// 3. KV ADMIN & USER REGISTRY HELPERS 
// =========================================================

// --- Admin ID Management ---
async function getAdminIds(env: Env): Promise<string[]> {
    const adminListJson = await env.KV_BINDING.get(ADMIN_LIST_KEY);
    return adminListJson ? JSON.parse(adminListJson) : [];
}

async function setAdminIds(adminIds: string[], env: Env): Promise<boolean> {
    return await safeKVPut(ADMIN_LIST_KEY, adminIds, env);
}

async function isAdmin(userId: number, env: Env): Promise<boolean> {
    const userIdString = userId.toString();
    const adminList = await getAdminIds(env);
    // Hardcode initial admin for setup if list is empty
    if (adminList.length === 0) {
        // Only return true if the user's ID matches the one being checked 
        // to prevent unauthorized access while list is being populated
        return false;
    }
    return adminList.includes(userIdString);
}

// --- Channel ID Management ---
async function getChannelId(env: Env): Promise<string | null> {
    return env.KV_BINDING.get(CHANNEL_ID_KEY);
}

async function setChannelId(channelId: string, env: Env): Promise<boolean> {
    return await safeKVPut(CHANNEL_ID_KEY, channelId, env);
}

// --- Payment Amount Management ---
async function getPaymentAmount(env: Env): Promise<string | null> {
    return env.KV_BINDING.get(PAYMENT_AMOUNT_KEY);
}

async function setPaymentAmount(amount: string, env: Env): Promise<boolean> {
    return await safeKVPut(PAYMENT_AMOUNT_KEY, amount, env);
}

// --- Payment Phone Management ---
async function getPaymentPhone(env: Env): Promise<string | null> {
    return env.KV_BINDING.get(PAYMENT_PHONE_KEY);
}

async function setPaymentPhone(phone: string, env: Env): Promise<boolean> {
    return await safeKVPut(PAYMENT_PHONE_KEY, phone, env);
}

// --- User Registry Management ---
async function getRegisteredUserIds(env: Env): Promise<string[]> {
    const idListJson = await env.KV_BINDING.get(USER_ID_LIST_KEY);
    return idListJson ? JSON.parse(idListJson) : [];
}

async function registerUserId(userId: number, env: Env): Promise<void> {
    const userIdString = userId.toString();
    const idList = await getRegisteredUserIds(env);

    if (!idList.includes(userIdString)) {
        idList.push(userIdString);
        await env.KV_BINDING.put(USER_ID_LIST_KEY, JSON.stringify(idList));
    }
}

// =========================================================
// 4. KV STATE MACHINE HELPERS 
// =========================================================

// --- Admin Conversational State (For text inputs like IDs) ---
async function getAdminPendingCommand(userId: number, env: Env): Promise<{ command: string } | null> {
    const json = await env.KV_BINDING.get(ADMIN_PENDING_PREFIX + userId.toString());
    return json ? JSON.parse(json) : null;
}

async function setAdminPendingCommand(userId: number, command: string, env: Env): Promise<void> {
    const state = { command: command };
    // Set expiry to 5 minutes
    await env.KV_BINDING.put(ADMIN_PENDING_PREFIX + userId.toString(), JSON.stringify(state), { expirationTtl: 300 });
}

async function clearAdminPendingCommand(userId: number, env: Env): Promise<void> {
    await env.KV_BINDING.delete(ADMIN_PENDING_PREFIX + userId.toString());
}

// --- User Payment State ---
interface UserPaymentState {
    status: string; // The STATE constant
    phone?: string; // Phone number provided by user
    timestamp: number; // For review/cleanup purposes
    inviteLink?: string; // The specific, single-use invite link
}

async function getUserState(userId: number, env: Env): Promise<UserPaymentState | null> {
    const json = await env.KV_BINDING.get(USER_STATE_PREFIX + userId.toString());
    return json ? JSON.parse(json) : null;
}

async function setUserState(userId: number, state: UserPaymentState, env: Env): Promise<void> {
    // Set expiry to 7 days
    await env.KV_BINDING.put(USER_STATE_PREFIX + userId.toString(), JSON.stringify(state), { expirationTtl: 604800 });
}

// =========================================================
// 5. CORE ACTION HANDLERS
// =========================================================

// Handles setting the private channel ID
async function handleSetChannelId(chat_id: number, channelId: string, env: Env) {
    const validation = validateChannelId(channelId);

    if (validation.valid) {
        const success = await setChannelId(channelId.trim(), env);
        if (success) {
            const responseMessage = `✅ Private Channel ID set to: \`${channelId.trim()}\``;
            await sendTelegramMessage(chat_id, responseMessage, env);
        } else {
            await sendTelegramMessage(chat_id, "❌ Failed to save Channel ID. Please try again.", env);
        }
    } else {
        await sendTelegramMessage(chat_id, `❌ ${validation.error}`, env);
    }
}

// Handles setting the payment amount
async function handleSetPaymentAmount(chat_id: number, amount: string, env: Env) {
    const validation = validatePaymentAmount(amount);

    if (validation.valid) {
        const success = await setPaymentAmount(amount.trim(), env);
        if (success) {
            await sendTelegramMessage(chat_id, `✅ Payment amount set to: \`${amount.trim()}\` ETB.`, env);
        } else {
            await sendTelegramMessage(chat_id, "❌ Failed to save payment amount. Please try again.", env);
        }
    } else {
        await sendTelegramMessage(chat_id, `❌ ${validation.error}`, env);
    }
}

// Handles setting the payment phone number
async function handleSetPaymentPhone(chat_id: number, phone: string, env: Env) {
    const validation = validateEthiopianPhone(phone);

    if (validation.valid && validation.normalized) {
        const success = await setPaymentPhone(validation.normalized, env);
        if (success) {
            await sendTelegramMessage(chat_id, `✅ Payment phone number set to: \`${validation.normalized}\`.`, env);
        } else {
            await sendTelegramMessage(chat_id, "❌ Failed to save payment phone. Please try again.", env);
        }
    } else {
        await sendTelegramMessage(chat_id, `❌ ${validation.error}`, env);
    }
}

// Handles adding an admin
async function handleAddAdmin(chat_id: number, newAdminIdString: string, env: Env) {
    const validation = validateUserId(newAdminIdString);

    if (validation.valid) {
        const trimmedId = newAdminIdString.trim();
        const currentAdmins = await getAdminIds(env);

        if (!currentAdmins.includes(trimmedId)) {
            currentAdmins.push(trimmedId);
            const success = await setAdminIds(currentAdmins, env);

            if (success) {
                await sendTelegramMessage(chat_id, `✅ User ID \`${trimmedId}\` added as admin.`, env);
            } else {
                await sendTelegramMessage(chat_id, "❌ Failed to add admin. Please try again.", env);
            }
        } else {
            await sendTelegramMessage(chat_id, `⚠️ User ID \`${trimmedId}\` is already an admin.`, env);
        }
    } else {
        await sendTelegramMessage(chat_id, `❌ ${validation.error}`, env);
    }
}

// Handles removing an admin (Called by callback button)
async function handleRemoveAdminAction(chat_id: number, targetAdminIdString: string, env: Env) {
    const validation = validateUserId(targetAdminIdString);

    if (!validation.valid) {
        await sendTelegramMessage(chat_id, `❌ ${validation.error}`, env);
        return;
    }

    const trimmedId = targetAdminIdString.trim();

    if (trimmedId === chat_id.toString()) {
        await sendTelegramMessage(chat_id, "❌ You cannot remove yourself as an admin.", env);
        return;
    }

    let currentAdmins = await getAdminIds(env);
    const initialLength = currentAdmins.length;

    currentAdmins = currentAdmins.filter(id => id !== trimmedId);

    if (currentAdmins.length < initialLength) {
        const success = await setAdminIds(currentAdmins, env);

        if (success) {
            const adminDetails = await getUserDisplayDetails(parseInt(trimmedId, 10), env);
            await sendTelegramMessage(chat_id, `🗑️ Admin *${adminDetails}* (\`${trimmedId}\`) removed.`, env);
        } else {
            await sendTelegramMessage(chat_id, "❌ Failed to remove admin. Please try again.", env);
        }
    } else {
        await sendTelegramMessage(chat_id, `⚠️ User ID \`${trimmedId}\` was not found in the admin list.`, env);
    }
}

// Handles approving a payment 
async function handleApprovePayment(chat_id: number, targetUserIdString: string, env: Env) {
    if (!targetUserIdString || !/^\d+$/.test(targetUserIdString)) {
        await sendTelegramMessage(chat_id, "❌ Invalid User ID.", env);
        return;
    }
    const targetUserId = parseInt(targetUserIdString, 10);
    const currentState = await getUserState(targetUserId, env);

    if (!currentState || currentState.status !== STATE.PENDING_ADMIN_REVIEW) {
        await sendTelegramMessage(chat_id, `⚠️ User ID \`${targetUserIdString}\` is not currently pending review.`, env);
        return;
    }

    const currentChannelId = await getChannelId(env);
    if (!currentChannelId) {
        await sendTelegramMessage(chat_id, "❌ Channel ID is not set. Approval failed.", env);
        return;
    }

    // 1. Generate Link
    const userDetails = await getUserDisplayDetails(targetUserId, env);
    const inviteLinkObject = await generateSingleUseInviteLink(
        currentChannelId,
        `Payment Approved for ${userDetails}`,
        env
    );

    if (inviteLinkObject) {
        const inviteLink = inviteLinkObject.invite_link;

        // 2. Send Link to User
        const deliveryMessage = `${PAYMENT_APPROVED}\n\n[Click to Join](${inviteLink})`;
        await sendTelegramMessage(targetUserId, deliveryMessage, env);

        // 3. Update State to APPROVED and STORE the link
        await setUserState(targetUserId, {
            status: STATE.APPROVED,
            phone: currentState.phone,
            timestamp: Date.now(),
            inviteLink: inviteLink // <--- STORED HERE
        }, env);

        // 4. Notify Admin
        await sendTelegramMessage(chat_id, `✅ Payment for User ${userDetails} (\`${targetUserIdString}\`) *APPROVED* and invite link sent.`, env);
    } else {
        await sendTelegramMessage(chat_id, "❌ Failed to generate invite link. Approval failed. Check bot channel permissions.", env);
    }
}

// Handles rejecting a payment
async function handleRejectPayment(chat_id: number, targetUserIdString: string, env: Env) {
    if (!targetUserIdString || !/^\d+$/.test(targetUserIdString)) {
        await sendTelegramMessage(chat_id, "❌ Invalid User ID.", env);
        return;
    }
    const targetUserId = parseInt(targetUserIdString, 10);
    const currentState = await getUserState(targetUserId, env);

    if (!currentState || currentState.status !== STATE.PENDING_ADMIN_REVIEW) {
        await sendTelegramMessage(chat_id, `⚠️ User ID \`${targetUserIdString}\` is not currently pending review.`, env);
        return;
    }

    // 1. Notify User of Rejection
    await sendTelegramMessage(targetUserId, PAYMENT_REJECTED, env);

    // 2. Update State to REJECTED 
    await setUserState(targetUserId, { status: STATE.REJECTED, phone: currentState.phone, timestamp: Date.now() }, env);

    // 3. Notify Admin
    const userDetails = await getUserDisplayDetails(targetUserId, env);
    await sendTelegramMessage(chat_id, `🗑️ Payment for User ${userDetails} (\`${targetUserIdString}\`) *REJECTED*.`, env);
}


// Handles revoking access for an APPROVED user
async function handleRevokeAccess(chat_id: number, targetUserIdString: string, env: Env) {
    if (!targetUserIdString || !/^\d+$/.test(targetUserIdString)) {
        await sendTelegramMessage(chat_id, "❌ Invalid User ID.", env);
        return;
    }
    const targetUserId = parseInt(targetUserIdString, 10);
    const currentState = await getUserState(targetUserId, env);

    if (!currentState || currentState.status !== STATE.APPROVED) {
        await sendTelegramMessage(chat_id, `⚠️ User ID \`${targetUserIdString}\` is not currently \`APPROVED\`. Revocation failed.`, env);
        return;
    }

    const currentChannelId = await getChannelId(env);
    if (!currentChannelId) {
        await sendTelegramMessage(chat_id, "❌ Channel ID is not set. Cannot revoke access.", env);
        return;
    }

    // --- REVOKE INVITE LINK FIRST ---
    let linkRevoked = false;
    const storedLink = currentState.inviteLink;
    if (storedLink) {
        // To "delete" a link in Telegram, we revoke it. 
        // We can also try to edit it to be expired immediately if it wasn't already.
        linkRevoked = await revokeChatInviteLink(currentChannelId, storedLink, env);
        if (linkRevoked) {
            await sendTelegramMessage(chat_id, `🔗 User's invite link successfully *REVOKED* and invalidated.`, env);
        } else {
            await sendTelegramMessage(chat_id, `⚠️ Failed to revoke invite link. It may have already been consumed or expired.`, env);
        }
    } else {
        await sendTelegramMessage(chat_id, `⚠️ No invite link found in user state. Proceeding with kick only.`, env);
    }
    // --- END REVOKE LINK ---

    // 1. Kick User from Channel
    const kickSuccessful = await unbanChatMember(currentChannelId, targetUserId, env);
    if (kickSuccessful) {
        await sendTelegramMessage(chat_id, `✅ User \`${targetUserIdString}\` *KICKED* from channel \`${currentChannelId}\`.`, env);
    } else {
        await sendTelegramMessage(chat_id, `⚠️ Failed to KICK user \`${targetUserIdString}\` from channel. Check bot permissions.`, env);
    }

    // 2. Notify User of Revocation
    await sendTelegramMessage(targetUserId, ACCESS_REVOKED, env);

    // 3. Update State to REJECTED (clears the link as well)
    // We intentionally do not carry the inviteLink forward when setting status to REJECTED
    await setUserState(targetUserId, { status: STATE.REJECTED, phone: currentState.phone, timestamp: Date.now() }, env);

    // 4. Notify Admin
    const userDetails = await getUserDisplayDetails(targetUserId, env);
    await sendTelegramMessage(chat_id, `🗑️ Access for User ${userDetails} (\`${targetUserIdString}\`) *REVOKED* (State set to REJECTED).`, env);
}


// =========================================================
// 6. HELPERS FOR ADMIN DATA LISTS
// =========================================================

// Fetches users in a specific state
async function getUsersInState(targetState: string, env: Env) {
    const allKeys = await env.KV_BINDING.list({ prefix: USER_STATE_PREFIX });
    const userList: { id: string, state: UserPaymentState, displayName: string }[] = [];

    for (const key of allKeys.keys) {
        const userIdString = key.name.replace(USER_STATE_PREFIX, '');
        const userId = parseInt(userIdString, 10);
        const state = await getUserState(userId, env);

        if (state && state.status === targetState) {
            const displayName = await getUserDisplayDetails(userId, env);
            userList.push({ id: userIdString, state, displayName });
        }
    }
    return userList;
}

// =========================================================
// 7. ADMIN MENU GENERATION
// =========================================================

// Detailed Admin Help Message (Now a simple menu intro)
async function getAdminMenu(env: Env) {
    const currentChannelId = await getChannelId(env);

    return {
        text: `👑 *Admin Control Panel*
\n*Channel ID:* \`${currentChannelId || 'NOT SET'}\`
\nSelect an option below to manage users and configuration.`,
        markup: {
            inline_keyboard: [
                // Row 1: Review & Approved Users
                [{ text: "💰 Review Payments", callback_data: "/review_payments" },
                { text: "👥 List Approved Users", callback_data: "/list_approved" }],
                // Row 2: Configuration
                [{ text: "⚙️ Set Channel ID", callback_data: "/set_channel_id_flow" },
                { text: "💵 Set Payment Amount", callback_data: "/set_payment_amount_flow" }],
                // Row 3: Configuration (continued)
                [{ text: "📞 Set Payment Phone", callback_data: "/set_payment_phone_flow" },
                { text: "🔐 Manage Admins", callback_data: "/manage_admins" }],
                // Row 4: Utility
                [{ text: "🗓️ Check Expired", callback_data: "/check_expired_subscriptions" },
                { text: "📦 List All Users", callback_data: "/list_users" }],
                // Row 5: Status
                [{ text: "ℹ️ Who is Admin / Status", callback_data: "/whoisadmin" }]
            ]
        }
    };
}

// Sub-menu for Admin Management
function getAdminManagementMenu() {
    return {
        text: "🔐 *Admin Management*\n\nChoose an action for admin IDs:",
        markup: {
            inline_keyboard: [
                [{ text: "➕ Add Admin", callback_data: "/add_admin_flow" }],
                [{ text: "➖ Remove Admin", callback_data: "/remove_admin_flow" }], // This now lists admins
                [{ text: "⬅️ Back to Main Menu", callback_data: "/admin_menu" }]
            ]
        }
    };
}


// =========================================================
// 8. USER FLOW HANDLER 
// =========================================================

async function handleRegularUserFlow(chat_id: number, text: string, sender_id: number, env: Env) {
    const currentState = await getUserState(sender_id, env);

    // --- 8A: Handle /confirm_payment Command (Only triggered by button callback now) ---
    if (text === '/confirm_payment') {
        if (!currentState) {
            await sendTelegramMessage(chat_id, `🚫 Please /start first to use /confirm_payment.`, env);
            return new Response('OK');
        }

        if (currentState.status === STATE.PENDING_CONFIRMATION) {
            // Move to admin review state
            await setUserState(sender_id, { status: STATE.PENDING_ADMIN_REVIEW, phone: currentState.phone, timestamp: Date.now() }, env);
            await sendTelegramMessage(chat_id, PENDING_ADMIN_INITIAL_MESSAGE, env);

            // --- NEW: NOTIFY ALL ADMINS ---
            const userDetails = await getUserDisplayDetails(sender_id, env);

            const notificationText = `🔔 *NEW PAYMENT REVIEW REQUIRED!* 🔔
*User:* ${userDetails} (ID: \`${sender_id}\`)
*Phone:* \`${currentState.phone}\`
*Status:* PENDING REVIEW
`;
            const notificationMarkup = {
                inline_keyboard: [
                    [{ text: "✅ Approve", callback_data: `/approve ${sender_id}` },
                    { text: "❌ Reject", callback_data: `/reject ${sender_id}` }],
                    [{ text: "📜 Review All Pending", callback_data: "/review_payments" }]
                ]
            };

            const adminIds = await getAdminIds(env);
            await Promise.all(adminIds.map(adminId =>
                sendTelegramMessage(parseInt(adminId, 10), notificationText, env, notificationMarkup)
            ));
            // --- END NEW NOTIFICATION ---

        } else if (currentState.status === STATE.PENDING_ADMIN_REVIEW || currentState.status === STATE.APPROVED) {
            await sendTelegramMessage(chat_id, `⚠️ You have already sent for confirmation. Please wait.`, env);
        } else {
            // Status: WAITING_FOR_PHONE, REJECTED (user should restart)
            await sendTelegramMessage(chat_id, `🚫 To use /confirm_payment, please send your payment phone number first.`, env);
        }
        return new Response('OK');
    }

    // --- 8B: Handle Payment Phone Number Input ---

    // Check if the user is in the state WAITING_FOR_PHONE
    if (currentState && currentState.status === STATE.WAITING_FOR_PHONE) {
        // IGNORE COMMANDS: If text starts with '/', let the main router handle it.
        if (text.startsWith('/')) {
            return null;
        }

        const phone = text.trim();
        const validation = validateEthiopianPhone(phone);

        if (validation.valid && validation.normalized) {
            // Valid phone number received - store normalized version
            await setUserState(sender_id, {
                status: STATE.PENDING_CONFIRMATION,
                phone: validation.normalized,
                timestamp: Date.now()
            }, env);

            // Send message with the Confirm Payment button
            const markup = {
                inline_keyboard: [
                    [{ text: "✅ Confirm Payment", callback_data: "/confirm_payment" }]
                ]
            };

            await sendTelegramMessage(chat_id, PHONE_RECEIVED, env, markup);
        } else {
            // Invalid phone number format - show specific error
            const errorMsg = validation.error || INVALID_PHONE;
            await sendTelegramMessage(chat_id, `❌ ${errorMsg}`, env);
        }
        return new Response('OK');
    }

    // --- 8C: Handle other messages if user is in middle of flow ---
    if (currentState && currentState.status !== STATE.APPROVED && currentState.status !== STATE.REJECTED) {
        if (currentState.status === STATE.PENDING_CONFIRMATION) {
            // Show the button again if user sends random text
            const markup = { inline_keyboard: [[{ text: "✅ Confirm Payment", callback_data: "/confirm_payment" }]] };
            await sendTelegramMessage(chat_id, `⚠️ Phone number received. Please press the button below.`, env, markup);
        } else if (currentState.status === STATE.PENDING_ADMIN_REVIEW) {
            await sendTelegramMessage(chat_id, PENDING_ADMIN, env);
        }
        return new Response('OK');
    }

    return null; // Return null to let the main router continue processing.
}

// =========================================================
// 9. CALLBACK QUERY HANDLER (NEW)
// =========================================================
async function handleCallbackQuery(query: any, env: Env) {
    const chat_id = query.message?.chat.id || query.from.id;
    const message_id = query.message?.message_id;
    const data = query.data;
    const sender_id = query.from.id;
    const senderIsAdmin = await isAdmin(sender_id, env);

    // Acknowledge the callback immediately
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: query.id }),
    });

    const parts = data.split(/\s+/);
    const command = parts[0];
    const argument = parts[1];

    // --- Admin Actions via Buttons ---
    if (senderIsAdmin) {

        switch (command) {
            case '/admin_menu': {
                const menu = await getAdminMenu(env);
                if (message_id) {
                    await editTelegramMessage(chat_id, message_id, menu.text, env, menu.markup);
                } else {
                    await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
                }
                break;
            }

            case '/manage_admins': {
                const menu = getAdminManagementMenu();
                if (message_id) {
                    await editTelegramMessage(chat_id, message_id, menu.text, env, menu.markup);
                } else {
                    await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
                }
                break;
            }

            case '/approve':
                if (argument) await handleApprovePayment(chat_id, argument, env);
                await handleReviewPayments(chat_id, env, message_id); // Refresh the review list in-place if possible
                break;

            case '/reject':
                if (argument) await handleRejectPayment(chat_id, argument, env);
                await handleReviewPayments(chat_id, env, message_id); // Refresh the review list in-place
                break;

            case '/revoke_access':
                if (argument) await handleRevokeAccess(chat_id, argument, env);
                await handleListApprovedUsers(chat_id, env, message_id); // Refresh the approved list in-place
                break;

            case '/review_payments':
                await handleReviewPayments(chat_id, env, message_id);
                break;

            case '/list_approved':
                await handleListApprovedUsers(chat_id, env, message_id);
                break;

            case '/whoisadmin':
                await handleWhoIsAdmin(chat_id, env, message_id);
                break;

            case '/cancel':
                await clearAdminPendingCommand(sender_id, env);
                if (message_id) {
                    await editTelegramMessage(chat_id, message_id, "🚫 Operation cancelled.", env);
                    // Re-show admin menu after a short delay or immediately append it? 
                    // Better to just show the menu.
                    const menu = await getAdminMenu(env);
                    await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
                } else {
                    await sendTelegramMessage(chat_id, "🚫 Operation cancelled.", env);
                    const menu = await getAdminMenu(env);
                    await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
                }
                break;

            case '/list_users':
                await handleListAllUsers(chat_id, env);
                break;

            case '/remove_admin_flow': // Button click to start admin list for removal
                await handleListAdminsForRemoval(chat_id, env);
                break;

            case '/remove_admin_action': // Button click next to admin's name
                if (argument) await handleRemoveAdminAction(chat_id, argument, env);
                await handleListAdminsForRemoval(chat_id, env); // Refresh the list
                break;

            // --- Conversational Flow Start (Text Input Required) ---
            case '/set_channel_id_flow':
                await setAdminPendingCommand(sender_id, '/set_channel_id', env);
                await editTelegramMessage(chat_id, query.message.message_id, "Please reply with the *Channel ID* (e.g., `-100xxxxxxxxxx`) you want to set.", env, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "/cancel" }]] });
                break;

            case '/set_payment_amount_flow':
                await setAdminPendingCommand(sender_id, '/set_payment_amount', env);
                await editTelegramMessage(chat_id, query.message.message_id, "Please reply with the *Payment Amount* in ETB (e.g., `100` or `99.99`).", env, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "/cancel" }]] });
                break;

            case '/set_payment_phone_flow':
                await setAdminPendingCommand(sender_id, '/set_payment_phone', env);
                await editTelegramMessage(chat_id, query.message.message_id, "Please reply with the *Payment Phone Number* (e.g., `+2519xxxxxxxx` or `09xxxxxxxx`).", env, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "/cancel" }]] });
                break;
            case '/add_admin_flow':
                await setAdminPendingCommand(sender_id, '/add_admin', env);
                await editTelegramMessage(chat_id, query.message.message_id, "Please reply with the numerical *User ID* you want to add as an admin.", env, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "/cancel" }]] });
                break;

            case '/invite_user_flow': // Added a new utility button flow
                await setAdminPendingCommand(sender_id, '/invite_user', env);
                await editTelegramMessage(chat_id, query.message.message_id, "Please reply with the *Recipient's Numerical Telegram User ID* to send the invite link to.", env, { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "/cancel" }]] });
                break;
            case '/check_expired_subscriptions':
                await handleCheckExpiredSubscriptions(chat_id, env);
                break;

            default:
                // Handle unknown admin button
                await sendTelegramMessage(chat_id, "🚫 Unknown admin command. Please use the menu buttons.", env);
                break;
        }

    }
    // --- Regular User Confirmation Button ---
    else if (command === '/confirm_payment' && !senderIsAdmin) {
        // This is handled via the separate handleRegularUserFlow, but we process the state change here
        const flowResponse = await handleRegularUserFlow(chat_id, '/confirm_payment', sender_id, env);

        if (flowResponse) {
            // Edit the message to remove the button after successful confirmation
            const originalMessageText = query.message.text;
            const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
            const payload = {
                chat_id: chat_id,
                message_id: query.message.message_id,
                text: `${PENDING_ADMIN}`,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [] } // Remove buttons
            };
            await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        }
    }
}


// =========================================================
// 10. ADMIN COMMAND IMPLEMENTATIONS
// =========================================================

async function handleCheckExpiredSubscriptions(chat_id: number, env: Env) {
    await sendTelegramMessage(chat_id, "⏳ Checking for expired subscriptions... This might take a moment.", env);

    const approvedUsers = await getUsersInState(STATE.APPROVED, env);
    const now = Date.now();
    const MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

    let revokedCount = 0;
    const revokedUsers: string[] = [];

    for (const user of approvedUsers) {
        if (now - user.state.timestamp > MONTH_IN_MS) {
            await handleRevokeAccess(chat_id, user.id, env);
            revokedCount++;
            revokedUsers.push(`- ${user.displayName} (\`${user.id}\`)`);
        }
    }

    let reportMessage = `✅ Subscription Check Complete.\n\n*${revokedCount}* user(s) had their access revoked.`;
    if (revokedCount > 0) {
        reportMessage += `\n\n*Revoked Users:*\n${revokedUsers.join('\n')}`;
    }

    const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };
    await sendTelegramMessage(chat_id, reportMessage, env, markup);
}

async function handleUserStatusCommand(chat_id: number, sender_id: number, env: Env) {
    const currentState = await getUserState(sender_id, env);
    let statusMessage = USER_STATUS_MESSAGE + "\n\n";

    if (!currentState) {
        statusMessage += "❌ Not registered. Use `/start` to begin.";
    } else {
        statusMessage += `*Status:* \`${currentState.status}\`\n`;
        if (currentState.phone) {
            statusMessage += `*Phone:* \`${currentState.phone}\`\n`;
        }
        if (currentState.status === STATE.APPROVED) {
            const timeSinceApproval = Date.now() - currentState.timestamp;
            const daysSinceApproval = Math.floor(timeSinceApproval / (1000 * 60 * 60 * 24));
            const daysRemaining = 30 - daysSinceApproval;
            statusMessage += `*Days Remaining:* ${daysRemaining}\n`;
            statusMessage += ALREADY_APPROVED;
        } else if (currentState.status === STATE.PENDING_ADMIN_REVIEW) {
            statusMessage += PENDING_ADMIN;
        } else if (currentState.status === STATE.PENDING_CONFIRMATION) {
            statusMessage += PROMPT_CONFIRM;
        } else if (currentState.status === STATE.WAITING_FOR_PHONE) {
            statusMessage += `📲 Step 2: *Now, please send the phone number you paid from.* Supported formats: \`+2519xxxxxxxx\` or \`09xxxxxxxx\`.`;
        } else if (currentState.status === STATE.REJECTED) {
            statusMessage += ACCESS_REVOKED;
        }
    }
    await sendTelegramMessage(chat_id, statusMessage, env);
}


async function handleReviewPayments(chat_id: number, env: Env, message_id?: number) {
    const pendingUsers = await getUsersInState(STATE.PENDING_ADMIN_REVIEW, env);

    if (pendingUsers.length === 0) {
        const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };
        if (message_id) {
            await editTelegramMessage(chat_id, message_id, "✅ No payments are currently pending admin review.", env, markup);
        } else {
            await sendTelegramMessage(chat_id, "✅ No payments are currently pending admin review.", env, markup);
        }
        return;
    }

    const reviewList = pendingUsers.map(user =>
        `*User:* ${user.displayName}\n*ID:* \`${user.id}\`\n*Phone:* \`${user.state.phone || 'N/A'}\``
    ).join('\n---\n');

    // Generate dynamic inline buttons for each user - BUTTON TEXT SIMPLIFIED
    const buttons = pendingUsers.map(user => [
        { text: `✅ Approve ${user.displayName}`, callback_data: `/approve ${user.id}` },
        { text: `❌ Reject ${user.displayName}`, callback_data: `/reject ${user.id}` }
    ]);

    buttons.push([{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]);

    const markup = { inline_keyboard: buttons };

    if (message_id) {
        await editTelegramMessage(chat_id, message_id, `� *Pending Payments Review:*\n\n${reviewList}`, env, markup);
    } else {
        await sendTelegramMessage(chat_id, `📋 *Pending Payments Review:*\n\n${reviewList}`, env, markup);
    }
}

async function handleListApprovedUsers(chat_id: number, env: Env, message_id?: number) {
    const approvedUsers = await getUsersInState(STATE.APPROVED, env);

    if (approvedUsers.length === 0) {
        const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };
        if (message_id) {
            await editTelegramMessage(chat_id, message_id, "⚠️ No approved users found.", env, markup);
        } else {
            await sendTelegramMessage(chat_id, "⚠️ No approved users found.", env, markup);
        }
        return;
    }

    const approvedList = approvedUsers.map(user =>
        `*User:* ${user.displayName}\n*ID:* \`${user.id}\``
    ).join('\n---\n');

    // Generate dynamic inline buttons for each user - BUTTON TEXT SIMPLIFIED
    const buttons = approvedUsers.map(user =>
        [{ text: `� Revoke ${user.displayName}`, callback_data: `/revoke_access ${user.id}` }]
    );

    // Add back button
    buttons.push([{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]);

    const markup = { inline_keyboard: buttons };
    if (message_id) {
        await editTelegramMessage(chat_id, message_id, `👥 *Approved Users List:*\n\n${approvedList}`, env, markup);
    } else {
        await sendTelegramMessage(chat_id, `👥 *Approved Users List:*\n\n${approvedList}`, env, markup);
    }
}

// Displays list of admins with a remove button next to each
async function handleListAdminsForRemoval(chat_id: number, env: Env) {
    const adminIds = await getAdminIds(env);
    const selfId = chat_id.toString();

    let buttons: any[] = [];

    // Only list other admins for removal
    const targetAdmins = adminIds.filter(id => id !== selfId);

    if (targetAdmins.length === 0) {
        const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };
        await sendTelegramMessage(chat_id, `⚠️ No other admins are configured to remove. (Your ID: \`${selfId}\`)`, env, markup);
        return;
    }

    const detailsPromises = targetAdmins.map(async idString => {
        const id = parseInt(idString, 10);
        const displayName = await getUserDisplayDetails(id, env);
        return { id: idString, displayName: displayName };
    });

    const adminDetails = await Promise.all(detailsPromises);

    const adminListText = adminDetails.map(user =>
        `*Admin:* ${user.displayName} (*ID*: \`${user.id}\`)`
    ).join('\n');

    buttons = adminDetails.map(user =>
        [{ text: `➖ Remove ${user.displayName}`, callback_data: `/remove_admin_action ${user.id}` }]
    );

    // Add back button
    buttons.push([{ text: "⬅️ Back to Manage Admins", callback_data: "/manage_admins" }]);

    const responseMessage = `🗑️ *Select Admin to Remove:*\n\n${adminListText}`;
    const markup = { inline_keyboard: buttons };

    await sendTelegramMessage(chat_id, responseMessage, env, markup);
}


async function handleWhoIsAdmin(chat_id: number, env: Env, message_id?: number) {
    const adminIds = await getAdminIds(env);
    const adminList = adminIds.map(id => `- \`${id}\``).join('\n');
    const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };

    if (message_id) {
        await editTelegramMessage(chat_id, message_id, `👮‍♂️ *Current Admins:*\n\n${adminList}`, env, markup);
    } else {
        await sendTelegramMessage(chat_id, `👮‍♂️ *Current Admins:*\n\n${adminList}`, env, markup);
    }
}

async function handleListAllUsers(chat_id: number, env: Env) {
    const userIds = await getRegisteredUserIds(env);

    if (userIds.length === 0) {
        const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };
        await sendTelegramMessage(chat_id, "⚠️ User registry is empty. Users must send the \`/start\` command to register.", env, markup);
        return;
    }

    const detailsPromises = userIds.map(async idString => {
        const id = parseInt(idString, 10);
        const displayName = await getUserDisplayDetails(id, env);
        const state = await getUserState(id, env);
        return { id: idString, displayName: displayName, status: state?.status || 'N/A' };
    });

    const userDetails = await Promise.all(detailsPromises);

    const userListText = userDetails.map(user =>
        `*Display:* ${user.displayName}\n*ID:* \`${user.id}\` (*Status: ${user.status}*)`
    ).join('\n---\n');

    const responseMessage = `📊 *All Registered Users (${userIds.length}):*\n\n${userListText}`;
    const markup = { inline_keyboard: [[{ text: "⬅️ Back to Admin Menu", callback_data: "/admin_menu" }]] };

    await sendTelegramMessage(chat_id, responseMessage, env, markup);
}

// =========================================================
// 11. WEBHOOK HANDLER (Main Logic)
// =========================================================

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        return router.handle(request, env, ctx);
    },
};

// Health check route
router.get('/', () => new Response('Bot is running! ✅', { status: 200 }));

router.post('/webhook', async (request: Request, env: Env) => {
    console.log('[WEBHOOK] Received request');

    let update: any;
    try {
        if (request.method !== 'POST' || typeof request.json !== 'function') {
            console.log('[WEBHOOK] Invalid request method or no json function');
            return new Response('OK', { status: 200 });
        }
        update = await request.json();
        console.log('[WEBHOOK] Update received:', JSON.stringify(update));
    } catch (e) {
        console.error('[WEBHOOK] Error parsing request:', e);
        return new Response('OK', { status: 200 });
    }

    // --- A. HANDLE CALLBACK QUERIES (BUTTON CLICKS) ---
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return new Response('OK');
    }

    // Continue with message handling if no callback query
    if (!update.message) return new Response('OK', { status: 200 });

    const message = update.message;
    const chat_id = message.chat.id;
    const text = message.text || '';
    const sender_id = message.from.id;

    // --- CRITICAL STEP: REGISTER USER ON ANY COMMAND INTERACTION ---
    if (text.startsWith('/')) {
        await registerUserId(sender_id, env);
    }

    const senderIsAdmin = await isAdmin(sender_id, env);

    // =====================================================================
    // B. HANDLE REGULAR USER FLOW (Phone Number/Confirmation Text)
    // =====================================================================
    if (!senderIsAdmin && !text.startsWith('/start') && !text.startsWith('/help') && !text.startsWith('/status')) {
        const flowResponse = await handleRegularUserFlow(chat_id, text, sender_id, env);
        if (flowResponse) return flowResponse;
    }


    // =====================================================================
    // C. HANDLE ADMIN CONVERSATIONAL RESPONSE (Text input for IDs only)
    // =====================================================================
    if (!text.startsWith('/') && senderIsAdmin) {
        const pendingState = await getAdminPendingCommand(sender_id, env);

        if (pendingState) {
            const argument = text.trim();
            const command = pendingState.command;

            await clearAdminPendingCommand(sender_id, env);

            switch (command) {
                case '/set_channel_id':
                    await handleSetChannelId(chat_id, argument, env);
                    break;
                case '/set_payment_amount':
                    await handleSetPaymentAmount(chat_id, argument, env);
                    break;
                case '/set_payment_phone':
                    await handleSetPaymentPhone(chat_id, argument, env);
                    break;
                case '/add_admin':
                    await handleAddAdmin(chat_id, argument, env);
                    break;
                case '/invite_user':
                    const currentChannelId = await getChannelId(env);
                    if (!currentChannelId) {
                        await sendTelegramMessage(chat_id, "❌ Error: Private Channel ID is not set. Use \`/set_channel_id\` first.", env);
                        break;
                    }
                    await sendTelegramMessage(chat_id, `✅ Sending invite link to ${argument}.`, env);

                    if (argument && /^\d+$/.test(argument)) {
                        const inviteLinkObject = await generateSingleUseInviteLink(currentChannelId, `Manual Invite for ${argument}`, env);
                        if (inviteLinkObject) {
                            const inviteLink = inviteLinkObject.invite_link;
                            const deliveryMessage = `🎉 Your private channel invitation link is here: [Click to Join](${inviteLink})\n\n*This link is single-use and will expire after you click it.*`;
                            await sendTelegramMessage(parseInt(argument, 10), deliveryMessage, env);
                            await sendTelegramMessage(chat_id, `✅ Invitation link generated and sent directly to user ID \`${argument}\`.`, env);
                        } else {
                            await sendTelegramMessage(chat_id, "❌ Error generating link. Check bot admin permissions in the private channel.", env);
                        }
                    } else {
                        await sendTelegramMessage(chat_id, "❌ Invalid Recipient ID.", env);
                    }

                    break;
                default:
                    await sendTelegramMessage(chat_id, "🚫 State error: I forgot what command you started. Please type the command again.", env);
                    break;
            }
            // After successful conversational input, return to admin menu
            const menu = await getAdminMenu(env);
            await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
            return new Response('OK');
        }
    }


    // =====================================================================
    // D. HANDLE DIRECT COMMANDS 
    // =====================================================================

    // --- COMMAND: /start (Initiates Payment Flow) ---
    if (text === '/start') {
        console.log('[/start] Command received from user:', sender_id);

        try {
            // 1. Admin Check
            if (senderIsAdmin) {
                console.log('[/start] User is admin, showing admin menu');
                const first_name = message.from?.first_name || 'Admin';
                const safe_first_name = escapeMarkdown(first_name);
                let welcomeMessage = `Hello, *${safe_first_name}*! \n\n`;
                welcomeMessage += "👑 *Bot Admin* access detected. Opening control panel.\n\n";
                const menu = await getAdminMenu(env);
                await sendTelegramMessage(chat_id, welcomeMessage + menu.text, env, menu.markup);
                return new Response('OK');
            }

            // 2. Regular User Logic
            const first_name = message.from?.first_name || 'User';
            const safe_first_name = escapeMarkdown(first_name);

            // Get current state and config
            const currentState = await getUserState(sender_id, env);
            const channelId = await getChannelId(env);

            console.log(`[/start] User: ${sender_id} (${safe_first_name}), State: ${currentState?.status}`);

            // 3. Check if ALREADY APPROVED and STILL A MEMBER
            let isActiveMember = false;
            if (currentState && currentState.status === STATE.APPROVED && channelId) {
                const memberInfo = await getChatMember(channelId, sender_id, env);
                // Check if user is a member, admin, or creator
                if (memberInfo && ['creator', 'administrator', 'member'].includes(memberInfo.status)) {
                    isActiveMember = true;
                }
            }

            if (isActiveMember) {
                console.log('[/start] User is already an active member.');
                await sendTelegramMessage(chat_id, `Hello, *${safe_first_name}*! \n\n` + ALREADY_APPROVED, env);
                return new Response('OK');
            }

            // 4. Handle other states (New, Rejected, Pending, or Approved-but-left)
            let messageText = `Hello, *${safe_first_name}*! \n\n`;
            let showInstructions = false;
            let showConfirmButton = false;

            if (!currentState) {
                // Case: New User
                console.log('[/start] Case: New User');
                messageText += "Welcome to GoldBot! 🎉\n\n";
                showInstructions = true;
            }
            else if (currentState.status === STATE.APPROVED) {
                // Case: Approved but not in channel
                console.log('[/start] Case: Approved but not in channel');
                messageText += "It looks like you're no longer in the private channel. Let's get you registered again.\n\n";
                showInstructions = true;
            }
            else if (currentState.status === STATE.REJECTED) {
                // Case: Rejected, allow retry
                console.log('[/start] Case: Rejected');
                messageText += "Starting a new registration. Please follow the steps below.\n\n";
                showInstructions = true;
            }
            else if (currentState.status === STATE.WAITING_FOR_PHONE) {
                // Case: Already started, hasn't sent phone
                console.log('[/start] Case: Waiting for phone');

                // Fetch payment details
                let paymentAmount = 'UNKNOWN';
                let paymentPhone = 'UNKNOWN';
                try { paymentAmount = await getPaymentAmount(env) || 'UNKNOWN'; } catch (e) { }
                try { paymentPhone = await getPaymentPhone(env) || 'UNKNOWN'; } catch (e) { }

                messageText += `ℹ️ *Payment Reminder*\n\n`;
                messageText += `Please pay *${paymentAmount} ETB* to \`${paymentPhone}\` via Telebirr.\n\n`;
                messageText += `Then, send the *phone number* you used for payment here.`;
                // Do NOT set showInstructions = true
            }
            else if (currentState.status === STATE.PENDING_CONFIRMATION) {
                // Case: Sent phone, needs to click confirm
                console.log('[/start] Case: Pending Confirmation');
                messageText += "You have already provided your phone number. Please confirm your payment using the button below.\n\n";
                showConfirmButton = true;
            }
            else if (currentState.status === STATE.PENDING_ADMIN_REVIEW) {
                // Case: Waiting for admin
                console.log('[/start] Case: Pending Admin Review');
                messageText += "Your payment is currently pending admin review. Please wait for approval.\n\n";
            }

            // 5. Execute Actions based on flags
            if (showInstructions) {
                // Reset/Set state to WAITING_FOR_PHONE
                console.log('[/start] Action: Sending Instructions');
                await setUserState(sender_id, { status: STATE.WAITING_FOR_PHONE, timestamp: Date.now() }, env);

                let paymentAmount = 'UNKNOWN';
                let paymentPhone = 'UNKNOWN';
                try { paymentAmount = await getPaymentAmount(env) || 'UNKNOWN'; } catch (e) { }
                try { paymentPhone = await getPaymentPhone(env) || 'UNKNOWN'; } catch (e) { }

                const instructions = `
🎉 *Welcome to the Premium Channel!*

To get access, please follow these steps:

1️⃣ Make a payment of *${paymentAmount} ETB* via Telebirr to:
\`${paymentPhone}\` (Tap to copy)

2️⃣ After payment, simply *send the phone number* you used to pay right here in this chat.

_Example:_ \`0911223344\` or \`+251911223344\`

We will verify your payment and send you the invite link instantly! 🚀
`;
                messageText += instructions;
            }

            // 6. Send Message with Fallback Logic
            let success = false;
            if (showConfirmButton) {
                const markup = {
                    inline_keyboard: [[{ text: "✅ Confirm Payment", callback_data: "/confirm_payment" }]]
                };
                success = await sendTelegramMessage(chat_id, messageText, env, markup);
            } else {
                success = await sendTelegramMessage(chat_id, messageText, env);
            }

            // 7. Fallback if Markdown failed
            if (!success) {
                console.log('[/start] Markdown message failed, trying plain text fallback');
                const plainText = messageText.replace(/[*_`]/g, ''); // Strip markdown chars
                if (showConfirmButton) {
                    const markup = {
                        inline_keyboard: [[{ text: "✅ Confirm Payment", callback_data: "/confirm_payment" }]]
                    };
                    await sendTelegramMessage(chat_id, plainText, env, markup, undefined);
                } else {
                    await sendTelegramMessage(chat_id, plainText, env, undefined, undefined);
                }
            }

            return new Response('OK');

        } catch (e) {
            console.error("Critical error in /start handler:", e);
            await sendTelegramMessage(chat_id, "🆘 A critical error occurred. Please try again later.", env);
            return new Response('OK');
        }
    }


    // --- COMMAND: /help (Context-Aware) ---
    else if (text === '/help') {
        if (senderIsAdmin) {
            const menu = await getAdminMenu(env);
            await sendTelegramMessage(chat_id, menu.text, env, menu.markup);
        } else {
            await sendTelegramMessage(chat_id, REGULAR_HELP, env);
        }
        return new Response('OK');
    }

    // --- COMMAND: /status (for regular users) ---
    else if (text === '/status' && !senderIsAdmin) {
        await handleUserStatusCommand(chat_id, sender_id, env);
        return new Response('OK');
    }


    // --- ADMIN COMMANDS (Gated by senderIsAdmin) ---
    else if (senderIsAdmin) {
        // Fallback for unrecognized command by an admin
        if (text.startsWith('/')) {
            await sendTelegramMessage(chat_id, "Command not recognized. Please use the buttons or type \`/start\`/\`/help\` to open the main menu.", env);
        }
        return new Response('OK');
    }

    // --- FALLBACK (Non-admin or unrecognized command) ---
    else if (text.startsWith('/')) {
        await sendTelegramMessage(chat_id, "Command not recognized. Type \`/help\` for a list of available commands.", env);
        return new Response('OK');
    }

    return new Response('OK', { status: 200 });
});
