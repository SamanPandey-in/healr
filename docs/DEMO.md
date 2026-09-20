

## good
export GEMINI_API_KEY="AIza...your-key..."
npx cdk deploy

## make a request:
curl -X POST "https://18uvd9zfhe.execute-api.ap-south-1.amazonaws.com/prod/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"order-test-101","sku":"SKU-333","quantity":3}'

## bad: 
toggle to true..

export GEMINI_API_KEY="AIza...your-key..."
npx cdk deploy

## 5 reqs to FAULT SERVICE

for i in {1..5}; do
  curl -X POST "https://18uvd9zfhe.execute-api.ap-south-1.amazonaws.com/prod/orders" \
    -H "Content-Type: application/json" \
    -d "{\"orderId\":\"order-fault-$i\",\"sku\":\"SKU-123\",\"quantity\":2}"
  sleep 1
done