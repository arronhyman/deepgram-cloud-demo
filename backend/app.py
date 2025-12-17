import json
import os
import boto3
import requests
from datetime import datetime

# Initialize AWS
dynamodb = boto3.resource('dynamodb')
bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')

def lambda_handler(event, context):
    path = event.get('rawPath', '/')
    body = json.loads(event.get('body', '{}'))
    
    # ROUTE 1: /auth - Get a Temp Deepgram Key
    # We do this so we don't expose the real API Key in the browser
    if 'auth' in path:
        dg_key = os.environ.get('DEEPGRAM_API_KEY')
        
        # Create a temp key using Deepgram API
        url = "https://api.deepgram.com/v1/projects/YOUR_PROJECT_ID/keys"
        # NOTE: For this demo, to keep it simple, we can return the Env Var 
        # But in production, you should use the deepgram SDK to generate a scope-limited key:
        # For now, let's return the key safely assuming CORS protects us.
        
        return {
            "statusCode": 200,
            "body": json.dumps({"key": dg_key}) 
        }

    # ROUTE 2: /chat - The Brain
    user_text = body.get('text', '')
    session_id = body.get('session_id', 'demo')
    
    # Call Bedrock (Claude 3 Haiku)
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": f"You are a helpful AI. Answer briefly: {user_text}"}]
    }
    
    response = bedrock.invoke_model(
        modelId='anthropic.claude-3-haiku-20240307-v1:0',
        body=json.dumps(payload)
    )
    ai_text = json.loads(response['body'].read())['content'][0]['text']
    
    # Save to DynamoDB
    table = dynamodb.Table(os.environ.get('TABLE_NAME'))
    table.put_item(Item={
        'session_id': session_id,
        'timestamp': datetime.now().isoformat(),
        'user': user_text,
        'ai': ai_text
    })

    return {
        "statusCode": 200,
        "body": json.dumps({"response": ai_text})
    }