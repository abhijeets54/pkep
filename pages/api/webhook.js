import crypto from "crypto";
import * as whatsapp from "../../lib/whatsapp";
import {
  supabaseAdmin,
  getOfficerByPhone,
  saveContribution,
  storeMessage,
  updateMessageStatus,
  getOrCreateSession,
} from "../../lib/supabase";
import { recordWebhookReceived } from "./health";
import { trackWebhookRequest, logEvent } from "../../utils/monitoring";

// Webhook verification token
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
// Facebook App Secret for webhook signature verification
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

// Verify webhook signature from WhatsApp
function verifyWebhookSignature(req) {
  if (!FACEBOOK_APP_SECRET) {
    console.warn(
      "FACEBOOK_APP_SECRET not configured. Skipping signature verification."
    );
    return true;
  }

  const signature = req.headers["x-hub-signature-256"] || "";
  const body = req.body;

  if (!signature) {
    console.error("No signature found in headers");
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", FACEBOOK_APP_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");

  return signature === `sha256=${expectedSignature}`;
}

// Handle incoming text message
async function handleTextMessage(from, userId, messageId, text) {
  try {
    // Store the message in the database using service role
    await storeMessage(messageId, userId, from, text, "text");

    // Get officer information
    const officer = await getOfficerByPhone(from);

    // Get or create the user's session
    const session = await getOrCreateSession(userId, from);

    if (!session) {
      console.error("Failed to get or create session");
      return whatsapp.sendTextMessage(
        from,
        userId,
        "We're experiencing technical difficulties. Please try again later."
      );
    }

    // Check for special commands (Rose, Thorn, Bud format)
    const roseMatch = text.match(/^#rose\s*[:]*\s*(.*)/i);
    const thornMatch = text.match(/^#thorn\s*[:]*\s*(.*)/i);
    const budMatch = text.match(/^#bud\s*[:]*\s*(.*)/i);

    if (roseMatch && roseMatch[1]) {
      // Save as a Rose contribution
      const content = roseMatch[1].trim();
      const saved = await saveContribution(userId, "rose", content);

      if (saved) {
        return whatsapp.sendTextMessage(
          from,
          userId,
          "Thank you for sharing a positive practice! Your knowledge has been saved. Share more or use menu options to explore other features."
        );
      }
    } else if (thornMatch && thornMatch[1]) {
      // Save as a Thorn contribution
      const content = thornMatch[1].trim();
      const saved = await saveContribution(userId, "thorn", content);

      if (saved) {
        return whatsapp.sendTextMessage(
          from,
          userId,
          "Thank you for sharing a challenge you faced. Your knowledge has been saved. Share more or use menu options to explore other features."
        );
      }
    } else if (budMatch && budMatch[1]) {
      // Save as a Bud contribution
      const content = budMatch[1].trim();
      const saved = await saveContribution(userId, "bud", content);

      if (saved) {
        return whatsapp.sendTextMessage(
          from,
          userId,
          "Thank you for sharing your new idea! Your knowledge has been saved. Share more or use menu options to explore other features."
        );
      }
    }

    // Handle session state-specific text responses
    if (session.session_data.state === "rescheduling") {
      return whatsapp.sendTextMessage(
        from,
        userId,
        "Thanks for your reschedule request. Your meeting coordinator will contact you to confirm the new time."
      );
    }

    // Default response - send main menu
    return whatsapp.sendMainMenu(from, userId);
  } catch (error) {
    console.error("Error handling text message:", error);
    return whatsapp.sendTextMessage(
      from,
      userId,
      "We're experiencing technical difficulties. Please try again later."
    );
  }
}

// Handle interactive message response (buttons, lists)
async function handleInteractiveMessage(from, userId, messageId, interactive) {
  try {
    // Store the message in the database using service role
    await storeMessage(
      messageId,
      userId,
      from,
      JSON.stringify(interactive),
      "interactive"
    );

    // Get or create the user's session
    const session = await getOrCreateSession(userId, from);

    if (!session) {
      console.error("Failed to get or create session");
      return whatsapp.sendTextMessage(
        from,
        userId,
        "We're experiencing technical difficulties. Please try again later."
      );
    }

    if (interactive.type === "button_reply") {
      const buttonReply = interactive.button_reply;

      // Process button selection
      switch (buttonReply.id) {
        case "KNOWLEDGE_SHARING":
          // Update session state using service role
          await supabaseAdmin
            .from("whatsapp_sessions")
            .update({
              session_data: { state: "knowledge_sharing" },
              updated_at: new Date().toISOString(),
            })
            .eq("id", session.id);

          return whatsapp.sendKnowledgeSharingOptions(from, userId);

        case "MEETINGS":
          await supabaseAdmin
            .from("whatsapp_sessions")
            .update({
              session_data: { state: "meetings" },
              updated_at: new Date().toISOString(),
            })
            .eq("id", session.id);

          return whatsapp.sendMeetingInformation(from, userId);

        case "PERFORMANCE":
          await supabaseAdmin
            .from("whatsapp_sessions")
            .update({
              session_data: { state: "performance" },
              updated_at: new Date().toISOString(),
            })
            .eq("id", session.id);

          return whatsapp.sendPerformanceSnapshot(from, userId);

        case "VIEW_KNOWLEDGE":
          return whatsapp.sendTextMessage(
            from,
            userId,
            "This feature is coming soon. You'll be able to browse knowledge shared by your peers."
          );

        case "BEST_PRACTICES":
          return whatsapp.sendTextMessage(
            from,
            userId,
            "This feature is coming soon. You'll be able to see curated best practices from your peers."
          );

        case "BACK_MAIN":
          await supabaseAdmin
            .from("whatsapp_sessions")
            .update({
              session_data: { state: "main_menu" },
              updated_at: new Date().toISOString(),
            })
            .eq("id", session.id);

          return whatsapp.sendMainMenu(from, userId);

        default:
          return whatsapp.sendMainMenu(from, userId);
      }
    } else if (interactive.type === "list_reply") {
      const listReply = interactive.list_reply;
      return whatsapp.sendTextMessage(
        from,
        userId,
        `You selected: ${listReply.title}`
      );
    }

    // Default fallback
    return whatsapp.sendMainMenu(from, userId);
  } catch (error) {
    console.error("Error handling interactive message:", error);
    return whatsapp.sendTextMessage(
      from,
      userId,
      "We're experiencing technical difficulties. Please try again later."
    );
  }
}

// Webhook handler - No authentication required
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Handle GET requests (webhook verification)
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      console.log('Webhook verification request:', { mode, token, challenge });

      // Verify the token
      if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verified successfully');
        // Return the challenge value as plain text
        return res.status(200).setHeader('Content-Type', 'text/plain').send(challenge);
      } else {
        console.error('Webhook verification failed');
        return res.status(403).send('Verification failed');
      }
    }

    // Handle POST requests (webhook events)
    if (req.method === 'POST') {
      // Verify webhook signature
      if (!verifyWebhookSignature(req)) {
        console.error("Invalid webhook signature");
        return res.status(401).send("Invalid signature");
      }

      const body = req.body;
      console.log("Received webhook body:", JSON.stringify(body, null, 2));

      // Process WhatsApp messages
      if (body.object === "whatsapp_business_account") {
        for (const entry of body.entry) {
          for (const change of entry.changes) {
            if (change.value.messages) {
              for (const message of change.value.messages) {
                const from = message.from;
                const userId = change.value.metadata.phone_number_id;
                const messageId = message.id;

                try {
                  // Handle different message types
                  if (message.type === "text") {
                    await handleTextMessage(
                      from,
                      userId,
                      messageId,
                      message.text.body
                    );
                  } else if (message.type === "interactive") {
                    await handleInteractiveMessage(
                      from,
                      userId,
                      messageId,
                      message.interactive
                    );
                  }
                } catch (error) {
                  console.error("Error processing message:", error);
                  // Continue processing other messages even if one fails
                }
              }
            }

            // Process status updates
            if (change.value.statuses) {
              for (const status of change.value.statuses) {
                try {
                  await updateMessageStatus(status.id, status.status);
                } catch (error) {
                  console.error("Error updating message status:", error);
                }
              }
            }
          }
        }
      }

      // Always return 200 OK for webhook events
      return res.status(200).send('EVENT_RECEIVED');
    }

    // If we get here, it's an unsupported method
    return res.status(405).send('Method not allowed');
  } catch (error) {
    console.error("Webhook error:", error);
    logEvent("WEBHOOK_ERROR", {
      error: error.message,
      requestId: `webhook-${Date.now()}`
    });
    return res.status(500).send("Internal server error");
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    externalResolver: true,
  },
};
