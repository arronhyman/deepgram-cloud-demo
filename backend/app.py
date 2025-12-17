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
        # Retrieves the ARN you defined in template.yaml
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
    
    body = {}
    if event.get('body'):
        try:
            body = json.loads(event.get('body'))
        except:
            pass

    # Determine Action
    action = query_params.get('route') or query_params.get('action') or body.get('action', 'chat')

    # --- ROUTE 1: AUTH ---
    if action == 'auth':
        master_key = get_deepgram_key()
        if not master_key:
            return {
                "statusCode": 500, 
                "headers": headers, 
                "body": json.dumps({"error": "API Key not configured in Secrets Manager"})
            }
        
        # Return the key directly to the client
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"key": master_key})
        }

    # --- ROUTE 2: CHAT (With Sentiment) ---
    user_text = body.get('text', '')
    user_sentiment = body.get('sentiment', 'neutral') 
    session_id = body.get('session_id', 'demo_session')
    
    if not user_text:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "No text"})}

    # Prompt Engineering with Sentiment
    prompt = f"""
    User Input: "{user_text}"
    Detected Sentiment: {user_sentiment}
    
    You are a helpful voice assistant. 
    1. Answer the user's input clearly.
    2. Adjust your tone based on the detected sentiment (e.g., if they are frustrated, be empathetic).
    3. Keep your response short (max 2 sentences) because it will be spoken out loud.
    """
    
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 150,
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
                'sentiment': user_sentiment,
                'ai': ai_text
            })

        return {
            "statusCode": 200, 
            "headers": headers, 
            "body": json.dumps({"response": ai_text})
        }
        
    except Exception as e:
        print(f"Bedrock Error: {e}")
        return {
            "statusCode": 500, 
            "headers": headers, 
            "body": json.dumps({"error": str(e)})
        }