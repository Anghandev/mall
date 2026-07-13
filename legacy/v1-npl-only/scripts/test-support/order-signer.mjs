import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isAddress, isHexString, TypedDataEncoder, Wallet } from 'ethers';

const ORDER_TYPES = {
  OrderAuthorization: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'nplAmount', type: 'uint256' },
    { name: 'bnmLocked', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'orderDigest', type: 'bytes32' },
    { name: 'splitVersion', type: 'uint32' }
  ]
};

export async function startOrderSigner({ chainId, escrowAddress, wallet = Wallet.createRandom(), token, port = 0 } = {}) {
  const expectedChainId = requirePositiveInteger(chainId, 'chainId');
  const expectedEscrow = requireAddress(escrowAddress, 'escrowAddress');
  const signerAddress = await wallet.getAddress();
  const webhookToken = token || randomBytes(32).toString('hex');

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (!validToken(req, webhookToken)) return sendJson(res, 401, { error: 'INVALID_ORDER_SIGNING_TOKEN' });

      const body = await readJson(req);
      const { domain, types, message } = normalizeRequest(body, expectedChainId, expectedEscrow);
      const authorizationDigest = TypedDataEncoder.hash(domain, types, message);
      if (body.authorizationDigest && String(body.authorizationDigest).toLowerCase() !== authorizationDigest.toLowerCase()) {
        throw new Error('ORDER_AUTHORIZATION_DIGEST_MISMATCH');
      }
      const signature = await wallet.signTypedData(domain, types, message);
      sendJson(res, 200, {
        ok: true,
        signer: signerAddress,
        signerAddress,
        orderSignerAddress: signerAddress,
        authorizationDigest,
        signature,
        authorization: signature
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local order signer did not expose a TCP port');
  const url = `http://127.0.0.1:${address.port}/sign-order`;

  return {
    address: signerAddress,
    token: webhookToken,
    url,
    env: {
      ORDER_SIGNING_WEBHOOK_URL: url,
      ORDER_SIGNING_WEBHOOK_TOKEN: webhookToken,
      ORDER_SIGNER_ADDRESS: signerAddress,
      ESCROW_SPLIT_VERSION: '1'
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function normalizeRequest(body, expectedChainId, expectedEscrow) {
  const suppliedDomain = body?.domain || body?.typedData?.domain;
  const suppliedTypes = body?.types || body?.typedData?.types;
  const message = body?.value || body?.message || body?.typedData?.message || body?.orderAuthorization || body?.payload || body;
  const domain = suppliedDomain || {
    name: '24K Mall Escrow',
    version: '1',
    chainId: expectedChainId,
    verifyingContract: expectedEscrow
  };
  const types = suppliedTypes ? { ...suppliedTypes } : ORDER_TYPES;
  delete types.EIP712Domain;

  if (domain.name !== '24K Mall Escrow' || String(domain.version) !== '1') throw new Error('INVALID_ORDER_SIGNING_DOMAIN');
  if (Number(domain.chainId) !== expectedChainId) throw new Error('ORDER_SIGNING_CHAIN_MISMATCH');
  if (String(domain.verifyingContract || '').toLowerCase() !== expectedEscrow.toLowerCase()) throw new Error('ORDER_SIGNING_ESCROW_MISMATCH');
  if (body?.primaryType && body.primaryType !== 'OrderAuthorization') throw new Error('INVALID_ORDER_AUTHORIZATION_PRIMARY_TYPE');
  if (JSON.stringify(types.OrderAuthorization) !== JSON.stringify(ORDER_TYPES.OrderAuthorization)) throw new Error('INVALID_ORDER_AUTHORIZATION_TYPE');

  const normalized = {
    orderId: requireBytes32(message?.orderId, 'orderId'),
    buyer: requireAddress(message?.buyer || message?.buyerAddress, 'buyer'),
    seller: requireAddress(message?.seller || message?.sellerAddress, 'seller'),
    productId: requireBytes32(message?.productId, 'productId'),
    nplAmount: requireUnsigned(message?.nplAmount ?? message?.nplAmountWei, 'nplAmount'),
    bnmLocked: requireUnsigned(message?.bnmLocked ?? message?.bnmLockedWei, 'bnmLocked'),
    deadline: requireUnsigned(message?.deadline, 'deadline'),
    orderDigest: requireBytes32(message?.orderDigest, 'orderDigest'),
    splitVersion: requireUnsigned(message?.splitVersion, 'splitVersion')
  };
  if (BigInt(normalized.nplAmount) === 0n || BigInt(normalized.bnmLocked) === 0n || BigInt(normalized.splitVersion) === 0n) {
    throw new Error('INVALID_ORDER_AUTHORIZATION_VALUE');
  }
  return { domain, types: { OrderAuthorization: types.OrderAuthorization }, message: normalized };
}

function validToken(req, expected) {
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : String(req.headers['x-order-signing-token'] || req.headers['x-order-signer-token'] || '').trim();
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('ORDER_SIGNING_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_ORDER_SIGNING_JSON');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}

function requireAddress(value, name) {
  const address = String(value || '');
  if (!isAddress(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function requireBytes32(value, name) {
  const hex = String(value || '');
  if (!isHexString(hex, 32)) throw new Error(`${name} must be bytes32`);
  return hex;
}

function requireUnsigned(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`${name} must be an unsigned integer`);
  }
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}
