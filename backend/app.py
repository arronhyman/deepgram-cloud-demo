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

def add_cors_headers(response):
    """Add full CORS headers to any response"""
    if 'headers' not in response:
        response['headers'] = {}
    response['headers'].update({
        "Access-Control-Allow-Origin": "*",  # Or "https://deepgram.lesuto.com" for security
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",  # Add more if needed (e.g., Authorization)
        "Access-Control-Max-Age": "86400"
    })
    return response

def lambda_handler(event, context):
    # Base headers (will be enhanced with CORS)
    base_headers = {"Content-Type": "application/json"}

    # Explicitly handle preflight OPTIONS (critical for browsers)
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        response = {
            "statusCode": 200,
            "headers": base_headers,
            "body": ""
        }
        return add_cors_headers(response)

    query_params = event.get('queryStringParameters') or {}
    body = {}
    if event.get('body'):
        try:
            body = json.loads(event.get('body') or '{}')
        except:
            pass

    action = query_params.get('route') or query_params.get('action') or body.get('action', 'chat')

    # AUTH ROUTE
    if action == 'auth':
        master_key = get_deepgram_key()
        if not master_key:
            response = {
                "statusCode": 500,
                "headers": base_headers,
                "body": json.dumps({"error": "API Key not configured in Secrets Manager"})
            }
        else:
            response = {
                "statusCode": 200,
                "headers": base_headers,
                "body": json.dumps({"key": master_key})
            }
        return add_cors_headers(response)

    # CHAT ROUTE
    user_text = body.get('text', '').strip()
    user_sentiment = body.get('sentiment', 'neutral')
    session_id = body.get('session_id', 'demo_session')

    if not user_text:
        response = {
            "statusCode": 400,
            "headers": base_headers,
            "body": json.dumps({"error": "No text provided"})
        }
        return add_cors_headers(response)

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
        response_bedrock = bedrock.invoke_model(
            modelId='anthropic.claude-3-haiku-20240307-v1:0',
            body=json.dumps(payload)
        )
        result = json.loads(response_bedrock['body'].read())
        ai_text = result['content'][0]['text'].strip()

        # Optional DynamoDB log
        table_name = os.environ.get('TABLE_NAME')
        if table_name:
            dynamodb.Table(table_name).put_item(Item={
                'session_id': session_id,
                'timestamp': datetime.now().isoformat(),
                'user': user_text,
                'sentiment': user_sentiment,
                'ai': ai_text
            })

        response = {
            "statusCode": 200,
            "headers": base_headers,
            "body": json.dumps({"response": ai_text})
        }

    except Exception as e:
        print(f"Bedrock Error: {e}")
        response = {
            "statusCode": 500,
            "headers": base_headers,
            "body": json.dumps({"error": str(e)})
        }

    return add_cors_headers(response)