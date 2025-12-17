import json
import os
import boto3

# Initialize clients
secrets = boto3.client("secretsmanager")
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

def get_deepgram_key():
    try:
        # Replace with your actual secret logic
        secret_arn = os.environ.get("SECRETS_ARN") 
        if not secret_arn:
            return None
        response = secrets.get_secret_value(SecretId=secret_arn)
        return json.loads(response["SecretString"]).get("api_key")
    except Exception as e:
        print(f"Secret Error: {e}")
        return None

def lambda_handler(event, context):
    """
    Ensure Lambda Function URL Invoke Mode is set to RESPONSE_STREAM
    """
    
    # 1. HANDLE AUTH REQUEST (Standard JSON response)
    query_params = event.get("queryStringParameters") or {}
    if query_params.get("route") == "auth":
        key = get_deepgram_key()
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"key": key})
        }

    # 2. PARSE INPUT
    try:
        body = json.loads(event.get("body", "{}"))
        user_text = body.get("text", "")
    except:
        user_text = ""

    if not user_text:
        return {"statusCode": 400, "body": "No text provided"}

    # 3. PREPARE BEDROCK STREAM
    prompt = f"User: {user_text}\n\nAssistant: (Respond in 1 sentence)"
    
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 150,
        "messages": [{"role": "user", "content": prompt}]
    }

    try:
        # Call Bedrock with Streaming
        response = bedrock.invoke_model_with_response_stream(
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
            body=json.dumps(payload)
        )
        stream = response.get('body')
        
        # 4. GENERATOR FUNCTION
        # This yields chunks of text as they come from the model
        def response_stream():
            if stream:
                for event in stream:
                    chunk = event.get('chunk')
                    if chunk:
                        chunk_json = json.loads(chunk.get('bytes').decode())
                        
                        # Anthropic Delta Format
                        if chunk_json.get('type') == 'content_block_delta':
                            text_delta = chunk_json['delta']['text']
                            # Yield plain text chunk
                            yield text_delta

        return response_stream()

    except Exception as e:
        print(f"Bedrock Error: {e}")
        return {"statusCode": 500, "body": "AI Error"}