import json
import os
import boto3
from datetime import datetime

# Initialize AWS Services
dynamodb = boto3.resource('dynamodb')
bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
secrets = boto3.client('secretsmanager')

def get_deepgram_key():
    try:
        secret_arn = os.environ.get('SECRETS_ARN')
        if not secret_arn:
            return None
        response = secrets.get_secret_value(SecretId=secret_arn)
        return json.loads(response['SecretString'])['api_key']
    except Exception as e:
        print(f"Secret Error: {e}")
        return None

def lambda_handler(event, context):
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    }

    # 1. Handle CORS Preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {"statusCode": 200, "headers": headers}

    # 2. Parse Inputs (Query Params OR Body)
    query_params = event.get('queryStringParameters') or {}
    
    # Try to parse body safely
    body = {}
    if event.get('body'):
        try:
            body = json.loads(event.get('body'))
        except:
            pass

    # Determine Action: Check URL first (?route=auth), then Body ({action: 'auth'})
    action = query_params.get('route') or query_params.get('action') or body.get('action', 'chat')

    # --- ROUTE 1: AUTH ---
    if action == 'auth':
        master_key = get_deepgram_key()
        if not master_key or "PLACEHOLDER" in master_key:
            return {
                "statusCode": 500, 
                "headers": headers,
                "body": json.dumps({"error": "API Key not configured in Secrets Manager"})
            }
            
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"key": master_key})
        }

    # --- ROUTE 2: CHAT ---
    user_text = body.get('text', '')
    session_id = body.get('session_id', 'demo_session')
    
    if not user_text:
        return {
            "statusCode": 400, 
            "headers": headers, 
            "body": json.dumps({"error": "No text provided"})
        }

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
        
        # Log to DynamoDB (if table exists)
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
        return {
            "statusCode": 500, 
            "headers": headers, 
            "body": json.dumps({"error": str(e)})
        }