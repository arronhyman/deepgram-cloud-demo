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
    }

    # Handle CORS Preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {"statusCode": 200, "headers": headers}

    query_params = event.get('queryStringParameters') or {}
    body = {}
    if event.get('body'):
        try:
            body = json.loads(event.get('body'))
        except:
            pass

    action = query_params.get('route') or query_params.get('action') or body.get('action', 'chat')

    # AUTH ROUTE
    if action == 'auth':
        master_key = get_deepgram_key()
        if not master_key:
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

    # CHAT ROUTE
    user_text = body.get('text', '').strip()
    user_sentiment = body.get('sentiment', 'neutral') 
    session_id = body.get('session_id', 'demo_session')
    
    if not user_text:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "No text"})}

    prompt = f"""
    User Input: "{user_text}"
    Detected Sentiment: {user_sentiment}
    
    You are a helpful voice assistant. 
    1. Answer the user's input clearly.
    2. Adjust your tone based on the detected sentiment (e.g., if they are frustrated, be empathetic).
    3. Keep your response short (max 2 sentences) because it will be spoken out loud.
    4. You are an expert in providing concise and relevant information.
    5. Always aim to improve the user's experience based on their emotional state.
    6. Respond in a friendly and engaging manner.
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