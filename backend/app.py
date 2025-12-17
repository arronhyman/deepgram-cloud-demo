import json
import os
import boto3
import requests
from datetime import datetime

# Initialize AWS Services
dynamodb = boto3.resource('dynamodb')
bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
secrets = boto3.client('secretsmanager')

def get_deepgram_key():
    # Fetch from Secrets Manager to be secure
    try:
        secret_arn = os.environ.get('SECRETS_ARN')
        response = secrets.get_secret_value(SecretId=secret_arn)
        return json.loads(response['SecretString'])['api_key']
    except Exception as e:
        print(f"Secret Error: {e}")
        return None

def lambda_handler(event, context):
    # Determine which "route" was hit
    # Function URLs don't have paths like API Gateway, so we use query params or body
    # Simple convention: POST with {"action": "auth"} or {"action": "chat"}
    
    body = json.loads(event.get('body', '{}'))
    action = body.get('action', 'chat')
    
    headers = {
        "Content-Type": "application/json",
        # CORS is handled by FunctionUrlConfig, but good to have explicit just in case
        "Access-Control-Allow-Origin": "*" 
    }

    # --- ROUTE 1: AUTH (Get Temp Key) ---
    if action == 'auth':
        master_key = get_deepgram_key()
        if not master_key or "PLACEHOLDER" in master_key:
            return {"statusCode": 500, "body": json.dumps({"error": "API Key not configured in Secrets Manager"})}

        # Create a temporary key that expires in 10 seconds (just enough to connect)
        # We call Deepgram API to generate this "Scope Down" key
        dg_url = "https://api.deepgram.com/v1/projects/YOUR_PROJECT_ID/keys" 
        # Note: Finding Project ID dynamically is hard, usually easier to use a "standard" key 
        # with a Referer check. For this Demo, we will return the Master Key BUT 
        # in a real interview, say: "In prod, I'd generate a scoped temp key here."
        
        return {
            "statusCode": 200, 
            "headers": headers,
            "body": json.dumps({"key": master_key})
        }

    # --- ROUTE 2: CHAT (Bedrock) ---
    user_text = body.get('text', '')
    session_id = body.get('session_id', 'demo_session')
    
    if not user_text:
        return {"statusCode": 400, "body": json.dumps({"error": "No text"})}

    # Call Claude 3 Haiku
    prompt = f"User: {user_text}\n\nYou are a helpful support assistant. Answer in 1 short sentence."
    
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": prompt}]
    }
    
    try:
        response = bedrock.invoke_model(
            modelId='anthropic.claude-3-haiku-20240307-v1:0',
            body=json.dumps(payload)
        )
        result = json.loads(response['body'].read())
        ai_text = result['content'][0]['text']
        
        # Log to DynamoDB
        table_name = os.environ.get('TABLE_NAME')
        if table_name:
            dynamodb.Table(table_name).put_item(Item={
                'session_id': session_id,
                'timestamp': datetime.now().isoformat(),
                'user': user_text,
                'ai': ai_text
            })

        return {
            "statusCode": 200, 
            "headers": headers,
            "body": json.dumps({"response": ai_text})
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}