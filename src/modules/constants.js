// Chain configuration
export const POLYGON_CHAIN_ID = 137;

// Contract addresses (Polygon Mainnet)
export const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// API endpoints
export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
export const CLOB_API_URL = 'https://clob.polymarket.com';
export const DATA_API_URL = 'https://data-api.polymarket.com';

// ABIs (minimal)
export const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) external view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external view returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) external view returns (uint256[])',
  
  // ERC1155 approval methods (CTF contract implements ERC1155)
  // CRITICAL: Conditional tokens (YES/NO) are ERC1155 token IDs, NOT separate ERC20 contracts
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)'
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)'
];

// Constants
export const USDC_DECIMALS = 6; // CRITICAL: NOT 18!
export const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const BINARY_PARTITION = [1, 2]; // YES=1, NO=2
