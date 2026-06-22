// Google Apps Script to forward Shopee/Lazada order cancellations to Supabase
const SUPABASE_CANCELLATION_URL = "YOUR_SUPABASE_CANCELLATION_EDGE_FUNCTION_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY"; 

function checkCancellations() {
  // Target specifically order cancellation emails
  const searchQuery = "is:unread (from:shopee OR from:lazada) (subject:cancelled OR subject:cancellation)";
  const threads = GmailApp.search(searchQuery, 0, 10); 
  
  if (threads.length === 0) return;
  
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      const message = messages[j];
      
      if (message.isUnread()) {
        const payload = {
          email_body: message.getPlainBody(),
          email_subject: message.getSubject(),
        };
        
        const options = {
          method: "post",
          contentType: "application/json",
          headers: { "Authorization": "Bearer " + SUPABASE_ANON_KEY },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        };
        
        try {
          const response = UrlFetchApp.fetch(SUPABASE_CANCELLATION_URL, options);
          if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
            message.markRead();
          }
        } catch (error) {
          Logger.log("Error: " + error.toString());
        }
      }
    }
  }
}
