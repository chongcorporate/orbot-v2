// Google Apps Script to forward Shopee/Lazada order emails to Supabase Edge Function
//
// IMPORTANT: The Scout edge function now requires a shared-secret header (X-Orbot-Key)
// on every request. Before this script will work again, set the ORBOT_API_KEY script
// property once: in the Apps Script editor, go to Project Settings > Script Properties
// and add a property named ORBOT_API_KEY whose value matches the ORBOT_API_KEY secret
// configured on the Supabase Edge Function (Project Settings > Edge Functions > Secrets).
const SUPABASE_EDGE_FUNCTION_URL = "https://velgortxgdouxbkonirr.supabase.co/functions/v1/scout";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY_HERE";

function forwardOrdersToScout() {
  // Search for unread emails containing order confirmations
  // Modify the search query if your emails come from a different sender or have different subject lines
  const searchQuery = "is:unread (subject:\"Time to ship\" OR subject:\"order\" OR subject:\"order confirmation\")";
  const threads = GmailApp.search(searchQuery, 0, 10); // Process up to 10 threads at a time
  
  if (threads.length === 0) {
    Logger.log("No new order emails found.");
    return;
  }
  
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    
    for (let j = 0; j < messages.length; j++) {
      const message = messages[j];
      
      if (message.isUnread()) {
        const emailBody = message.getPlainBody();
        const emailSubject = message.getSubject();
        
        Logger.log("Processing email: " + emailSubject);
        
        // Prepare the payload for Supabase
        const payload = {
          email_body: emailBody,
          email_subject: emailSubject,
        };
        
        const options = {
          method: "post",
          contentType: "application/json",
          headers: {
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
            "X-Orbot-Key": PropertiesService.getScriptProperties().getProperty('ORBOT_API_KEY')
          },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true // Don't crash the script if the webhook fails
        };
        
        try {
          // Send Webhook to Supabase
          const response = UrlFetchApp.fetch(SUPABASE_EDGE_FUNCTION_URL, options);
          const responseCode = response.getResponseCode();
          
          if (responseCode >= 200 && responseCode < 300) {
            Logger.log("Successfully forwarded to Scout.");
            // Only mark as read if the Edge Function successfully ingested it!
            message.markRead();
          } else {
            Logger.log("Failed to forward. HTTP " + responseCode + ": " + response.getContentText());
          }
        } catch (error) {
          Logger.log("Error sending webhook: " + error.toString());
        }
      }
    }
  }
}
