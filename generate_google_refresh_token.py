import os
from google_auth_oauthlib.flow import InstalledAppFlow

# The scopes required by the Scout Agent
SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

def main():
    if not os.path.exists('credentials.json'):
        print("ERROR: 'credentials.json' not found!")
        print("Please download your OAuth client ID JSON file from the Google Cloud Console")
        print("and save it in this directory as 'credentials.json'.")
        return

    print("Opening browser to authenticate with Google...")
    
    # Initialize the flow
    flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
    
    # Run the local server to get the credentials
    creds = flow.run_local_server(port=0, access_type='offline', prompt='consent')

    print("\n" + "="*50)
    print("SUCCESS! Here are your credentials for Supabase Secrets:")
    print("="*50 + "\n")
    
    print(f"GOOGLE_CLIENT_ID='{creds.client_id}'")
    print(f"GOOGLE_CLIENT_SECRET='{creds.client_secret}'")
    print(f"GOOGLE_REFRESH_TOKEN='{creds.refresh_token}'")
    
    print("\n" + "="*50)
    print("Copy the values above and add them to your Supabase Edge Function Secrets.")
    print("WARNING: Keep your refresh token safe! Do not commit it to GitHub.")

if __name__ == '__main__':
    main()
