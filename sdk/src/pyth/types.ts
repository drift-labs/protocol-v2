import type { IdlAccounts } from '@coral-xyz/anchor';

export type WormholeCoreBridgeSolana = {
	version: '0.0.1-alpha.5';
	name: 'wormhole_core_bridge_solana';
	constants: [
		{
			name: 'SOLANA_CHAIN';
			type: 'u16';
			value: '1';
		},
		{
			name: 'FEE_COLLECTOR_SEED_PREFIX';
			type: 'bytes';
			value: '[102, 101, 101, 95, 99, 111, 108, 108, 101, 99, 116, 111, 114]';
		},
		{
			name: 'UPGRADE_SEED_PREFIX';
			type: 'bytes';
			value: '[117, 112, 103, 114, 97, 100, 101]';
		},
		{
			name: 'PROGRAM_EMITTER_SEED_PREFIX';
			type: 'bytes';
			value: '[101, 109, 105, 116, 116, 101, 114]';
		},
		{
			name: 'MAX_MESSAGE_PAYLOAD_SIZE';
			type: {
				defined: 'usize';
			};
			value: '30 * 1_024';
		},
	];
	instructions: [
		{
			name: 'initMessageV1';
			docs: [
				'Processor for initializing a new draft [PostedMessageV1](crate::state::PostedMessageV1)',
				'account for writing. The emitter authority is established at this point and the payload size',
				'is inferred from the size of the created account. This instruction handler also allows an',
				"integrator to publish Wormhole messages using his program's ID as the emitter address",
				'(by passing `Some(crate::ID)` to the [cpi_program_id](InitMessageV1Args::cpi_program_id)',
				'argument). **Be aware that the emitter authority\'s seeds must only be \\[b"emitter"\\] in this',
				'case.**',
				'',
				'This instruction should be followed up with `write_message_v1` and `finalize_message_v1` to',
				'write and indicate that the message is ready for publishing respectively (to prepare it for',
				'publishing via the',
				'[post message instruction](crate::legacy::instruction::LegacyInstruction::PostMessage)).',
				'',
				'NOTE: If you wish to publish a small message (one where the data does not overflow the',
				'Solana transaction size), it is recommended that you use an [sdk](crate::sdk::cpi) method to',
				'either prepare your message or post a message as a program ID emitter.',
			];
			accounts: [
				{
					name: 'emitterAuthority';
					isMut: false;
					isSigner: true;
					docs: [
						'This authority is the only one who can write to the draft message account.',
					];
				},
				{
					name: 'draftMessage';
					isMut: true;
					isSigner: false;
					docs: ['Bridge.'];
				},
			];
			args: [
				{
					name: 'args';
					type: {
						defined: 'InitMessageV1Args';
					};
				},
			];
		},
		{
			name: 'writeMessageV1';
			docs: [
				'Processor used to write to a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'This instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			];
			accounts: [
				{
					name: 'emitterAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'draftMessage';
					isMut: true;
					isSigner: false;
					docs: ['only be published when the message is finalized.'];
				},
			];
			args: [
				{
					name: 'args';
					type: {
						defined: 'WriteMessageV1Args';
					};
				},
			];
		},
		{
			name: 'finalizeMessageV1';
			docs: [
				'Processor used to finalize a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'Once finalized, this message account cannot be written to again. A finalized message is the',
				'only state the legacy post message instruction can accept before publishing. This',
				'instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			];
			accounts: [
				{
					name: 'emitterAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'draftMessage';
					isMut: true;
					isSigner: false;
					docs: ['only be published when the message is finalized.'];
				},
			];
			args: [];
		},
		{
			name: 'closeMessageV1';
			docs: [
				'Processor used to process a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'This instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			];
			accounts: [
				{
					name: 'emitterAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'draftMessage';
					isMut: true;
					isSigner: false;
					docs: ['only be published when the message is finalized.'];
				},
				{
					name: 'closeAccountDestination';
					isMut: true;
					isSigner: false;
				},
			];
			args: [];
		},
		{
			name: 'initEncodedVaa';
			docs: [
				'Processor used to intialize a created account as [EncodedVaa](crate::state::EncodedVaa). An',
				'authority (the write authority) is established with this instruction.',
			];
			accounts: [
				{
					name: 'writeAuthority';
					isMut: false;
					isSigner: true;
					docs: [
						'The authority who can write to the VAA account when it is being processed.',
					];
				},
				{
					name: 'encodedVaa';
					isMut: true;
					isSigner: false;
					docs: ['Bridge.'];
				},
			];
			args: [];
		},
		{
			name: 'closeEncodedVaa';
			docs: [
				'Processor used to close an [EncodedVaa](crate::state::EncodedVaa). This instruction requires',
				'an authority (the write authority) to interact witht he encoded VAA account.',
			];
			accounts: [
				{
					name: 'writeAuthority';
					isMut: true;
					isSigner: true;
					docs: [
						'This account is only required to be mutable for the `CloseVaaAccount` directive. This',
						'authority is the same signer that originally created the VAA accounts, so he is the one that',
						'will receive the lamports back for the closed accounts.',
					];
				},
				{
					name: 'encodedVaa';
					isMut: true;
					isSigner: false;
					docs: ['written to and then verified.'];
				},
			];
			args: [];
		},
		{
			name: 'writeEncodedVaa';
			docs: [
				'Processor used to write to an [EncodedVaa](crate::state::EncodedVaa) account. This',
				'instruction requires an authority (the write authority) to interact with the encoded VAA',
				'account.',
			];
			accounts: [
				{
					name: 'writeAuthority';
					isMut: false;
					isSigner: true;
					docs: [
						'The only authority that can write to the encoded VAA account.',
					];
				},
				{
					name: 'draftVaa';
					isMut: true;
					isSigner: false;
					docs: ['written to and then verified.'];
				},
			];
			args: [
				{
					name: 'args';
					type: {
						defined: 'WriteEncodedVaaArgs';
					};
				},
			];
		},
		{
			name: 'verifyEncodedVaaV1';
			docs: [
				'Processor used to verify an [EncodedVaa](crate::state::EncodedVaa) account as a version 1',
				'VAA (guardian signatures attesting to this observation). This instruction requires an',
				'authority (the write authority) to interact with the encoded VAA account.',
			];
			accounts: [
				{
					name: 'writeAuthority';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'draftVaa';
					isMut: true;
					isSigner: false;
					docs: ['written to and then verified.'];
				},
				{
					name: 'guardianSet';
					isMut: false;
					isSigner: false;
					docs: [
						'Guardian set account, which should be the same one that was used to attest for the VAA. The',
						'signatures in the encoded VAA are verified against this guardian set.',
					];
				},
			];
			args: [];
		},
		{
			name: 'postVaaV1';
			docs: [
				'Processor used to close an [EncodedVaa](crate::state::EncodedVaa) account to create a',
				'[PostedMessageV1](crate::state::PostedMessageV1) account in its place.',
				'',
				'NOTE: Because the legacy verify signatures instruction was not required for the Posted VAA',
				'account to exist, the encoded [SignatureSet](crate::state::SignatureSet) is the default',
				'[Pubkey].',
			];
			accounts: [
				{
					name: 'payer';
					isMut: true;
					isSigner: true;
					docs: [
						'Payer to create the posted VAA account. This instruction allows anyone with an encoded VAA',
						'to create a posted VAA account.',
					];
				},
				{
					name: 'encodedVaa';
					isMut: false;
					isSigner: false;
					docs: [
						'Encoded VAA, whose body will be serialized into the posted VAA account.',
						'',
						'NOTE: This instruction handler only exists to support integrators that still rely on posted',
						'VAA accounts. While we encourage integrators to use the encoded VAA account instead, we',
						'allow a pathway to convert the encoded VAA into a posted VAA. However, the payload is',
						'restricted to 9.5KB, which is much larger than what was possible with the old implementation',
						'using the legacy post vaa instruction. The Core Bridge program will not support posting VAAs',
						'larger than this payload size.',
					];
				},
				{
					name: 'postedVaa';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [];
		},
		{
			name: 'closeSignatureSet';
			docs: [
				'Processor used to close a [SignatureSet](crate::state::SignatureSet), which was used to',
				'verify the VAA using the legacy parse and verify procedure.',
			];
			accounts: [
				{
					name: 'solDestination';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'postedVaa';
					isMut: false;
					isSigner: false;
					docs: ['Posted VAA.'];
				},
				{
					name: 'signatureSet';
					isMut: true;
					isSigner: false;
					docs: [
						'Signature set that may have been used to create the posted VAA account. If the `post_vaa_v1`',
						'instruction were used to create the posted VAA account, then the encoded signature set',
						'pubkey would be all zeroes.',
					];
				},
			];
			args: [];
		},
	];
	accounts: [
		{
			name: 'guardianSet';
			docs: [
				'Account used to store a guardian set. The keys encoded in this account are Ethereum pubkeys.',
				'Its expiration time is determined at the time a guardian set is updated to a new set, where the',
				'current network clock time is used with',
				'[guardian_set_ttl](crate::state::Config::guardian_set_ttl).',
				'',
				'NOTE: The account schema is the same as legacy guardian sets, but this account now has a',
				"discriminator generated by Anchor's [account] macro. When the Core Bridge program performs a",
				'guardian set update with this implementation, guardian sets will now have this Anchor-generated',
				'discriminator.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'index';
						docs: [
							'Index representing an incrementing version number for this guardian set.',
						];
						type: 'u32';
					},
					{
						name: 'keys';
						docs: ['Ethereum-style public keys.'];
						type: {
							vec: {
								array: ['u8', 20];
							};
						};
					},
					{
						name: 'creationTime';
						docs: [
							'Timestamp representing the time this guardian became active.',
						];
						type: {
							defined: 'Timestamp';
						};
					},
					{
						name: 'expirationTime';
						docs: [
							'Expiration time when VAAs issued by this set are no longer valid.',
						];
						type: {
							defined: 'Timestamp';
						};
					},
				];
			};
		},
		{
			name: 'signatureSet';
			docs: [
				'Account used to store information about a guardian set used to sign a VAA. There is only one',
				'signature set for each verified VAA (associated with a',
				'[PostedVaaV1](crate::legacy::state::PostedVaaV1) account). This account is created using the',
				'verify signatures legacy instruction.',
				'',
				'NOTE: The account schema is the same as legacy signature sets, but this account now has a',
				"discriminator generated by Anchor's [account] macro. When the Core Bridge program upgrades to",
				'this implementation from the old one, integrators in the middle of verifying signatures will',
				'have to use a new keypair for this account and try again.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'sigVerifySuccesses';
						docs: ['Signatures of validators'];
						type: {
							vec: 'bool';
						};
					},
					{
						name: 'messageHash';
						docs: ['Hash of the VAA message body.'];
						type: {
							defined: 'MessageHash';
						};
					},
					{
						name: 'guardianSetIndex';
						docs: ['Index of the guardian set'];
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'encodedVaa';
			docs: [
				'Account used to warehouse VAA buffer.',
				'',
				"NOTE: This account should not be used by an external application unless the header's status is",
				'`Verified`. It is encouraged to use the `EncodedVaa` zero-copy account struct instead.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'header';
						docs: ['Status, write authority and VAA version.'];
						type: {
							defined: 'Header';
						};
					},
					{
						name: 'buf';
						docs: ['VAA buffer.'];
						type: 'bytes';
					},
				];
			};
		},
	];
	types: [
		{
			name: 'InitializeArgs';
			docs: ['Arguments used to initialize the Core Bridge program.'];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'guardianSetTtlSeconds';
						type: 'u32';
					},
					{
						name: 'feeLamports';
						type: 'u64';
					},
					{
						name: 'initialGuardians';
						type: {
							vec: {
								array: ['u8', 20];
							};
						};
					},
				];
			};
		},
		{
			name: 'PostMessageArgs';
			docs: [
				'Arguments used to post a new Wormhole (Core Bridge) message either using',
				'[post_message](crate::legacy::instruction::post_message) or',
				'[post_message_unreliable](crate::legacy::instruction::post_message_unreliable).',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'nonce';
						docs: ['Unique id for this message.'];
						type: 'u32';
					},
					{
						name: 'payload';
						docs: ['Encoded message.'];
						type: 'bytes';
					},
					{
						name: 'commitment';
						docs: ['Solana commitment level for Guardian observation.'];
						type: {
							defined: 'Commitment';
						};
					},
				];
			};
		},
		{
			name: 'PostVaaArgs';
			docs: [
				'Arguments to post new VAA data after signature verification.',
				'',
				'NOTE: It is preferred to use the new process of verifying a VAA using the new Core Bridge Anchor',
				'instructions. See [init_encoded_vaa](crate::wormhole_core_bridge_solana::init_encoded_vaa) and',
				'[write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa) for more info.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'gap0';
						docs: ['Unused data.'];
						type: {
							array: ['u8', 5];
						};
					},
					{
						name: 'timestamp';
						docs: ['Time the message was submitted.'];
						type: 'u32';
					},
					{
						name: 'nonce';
						docs: ['Unique ID for this message.'];
						type: 'u32';
					},
					{
						name: 'emitterChain';
						docs: [
							'The Wormhole chain ID denoting the origin of this message.',
						];
						type: 'u16';
					},
					{
						name: 'emitterAddress';
						docs: ['Emitter of the message.'];
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'sequence';
						docs: ['Sequence number of this message.'];
						type: 'u64';
					},
					{
						name: 'consistencyLevel';
						docs: ['Level of consistency requested by the emitter.'];
						type: 'u8';
					},
					{
						name: 'payload';
						docs: ['Message payload.'];
						type: 'bytes';
					},
				];
			};
		},
		{
			name: 'VerifySignaturesArgs';
			docs: [
				'Arguments to verify specific guardian indices.',
				'',
				'NOTE: It is preferred to use the new process of verifying a VAA using the new Core Bridge Anchor',
				'instructions. See [init_encoded_vaa](crate::wormhole_core_bridge_solana::init_encoded_vaa) and',
				'[write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa) for more info.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'signerIndices';
						docs: [
							'Indices of verified guardian signatures, where -1 indicates a missing value. There is a',
							'missing value if the guardian at this index is not expected to have its signature verfied by',
							'the Sig Verify native program in the instruction invoked prior).',
							'',
							'NOTE: In the legacy implementation, this argument being a fixed-sized array of 19 only',
							'allows the first 19 guardians of any size guardian set to be verified. Because of this, it',
							'is absolutely important to use the new process of verifying a VAA.',
						];
						type: {
							array: ['i8', 19];
						};
					},
				];
			};
		},
		{
			name: 'EmptyArgs';
			docs: ['Unit struct used to represent an empty instruction argument.'];
			type: {
				kind: 'struct';
				fields: [];
			};
		},
		{
			name: 'Config';
			docs: [
				'Account used to store the current configuration of the bridge, including tracking Wormhole fee',
				'payments. For governance decrees, the guardian set index is used to determine whether a decree',
				'was attested for using the latest guardian set.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'guardianSetIndex';
						docs: [
							'The current guardian set index, used to decide which signature sets to accept.',
						];
						type: 'u32';
					},
					{
						name: 'gap0';
						docs: [
							'Gap. In the old implementation, this was an amount that kept track of message fees that',
							"were paid to the program's fee collector.",
						];
						type: {
							array: ['u8', 8];
						};
					},
					{
						name: 'guardianSetTtl';
						docs: [
							'Period for how long a guardian set is valid after it has been replaced by a new one.  This',
							'guarantees that VAAs issued by that set can still be submitted for a certain period.  In',
							'this period we still trust the old guardian set.',
						];
						type: {
							defined: 'Duration';
						};
					},
					{
						name: 'feeLamports';
						docs: [
							'Amount of lamports that needs to be paid to the protocol to post a message',
						];
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'LegacyEmitterSequence';
			docs: [
				'Account used to store the current sequence number for a given emitter.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'value';
						docs: [
							'Current sequence number, which will be used the next time this emitter publishes a message.',
						];
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'EmitterSequence';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'legacy';
						type: {
							defined: 'LegacyEmitterSequence';
						};
					},
					{
						name: 'bump';
						type: 'u8';
					},
					{
						name: 'emitterType';
						type: {
							defined: 'EmitterType';
						};
					},
				];
			};
		},
		{
			name: 'PostedMessageV1Unreliable';
			docs: ['Account used to store a published (reusable) Wormhole message.'];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'data';
						type: {
							defined: 'PostedMessageV1Data';
						};
					},
				];
			};
		},
		{
			name: 'PostedMessageV1Info';
			docs: [
				'Message metadata defining information about a published Wormhole message.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'consistencyLevel';
						docs: ['Level of consistency requested by the emitter.'];
						type: 'u8';
					},
					{
						name: 'emitterAuthority';
						docs: [
							'Authority used to write the message. This field is set to default when the message is',
							'posted.',
						];
						type: 'publicKey';
					},
					{
						name: 'status';
						docs: [
							'If a message is being written to, this status is used to determine which state this',
							'account is in (e.g. [MessageStatus::Writing] indicates that the emitter authority is still',
							'writing its message to this account). When this message is posted, this value will be',
							'set to [MessageStatus::Published].',
						];
						type: {
							defined: 'MessageStatus';
						};
					},
					{
						name: 'gap0';
						docs: ['No data is stored here.'];
						type: {
							array: ['u8', 3];
						};
					},
					{
						name: 'postedTimestamp';
						docs: ['Time the posted message was created.'];
						type: {
							defined: 'Timestamp';
						};
					},
					{
						name: 'nonce';
						docs: ['Unique id for this message.'];
						type: 'u32';
					},
					{
						name: 'sequence';
						docs: ['Sequence number of this message.'];
						type: 'u64';
					},
					{
						name: 'solanaChainId';
						docs: [
							'Always `1`.',
							'',
							'NOTE: Saving this value is silly, but we are keeping it to be consistent with how the posted',
							'message account is written.',
						];
						type: {
							defined: 'ChainIdSolanaOnly';
						};
					},
					{
						name: 'emitter';
						docs: [
							'Emitter of the message. This may either be the emitter authority or a program ID.',
						];
						type: 'publicKey';
					},
				];
			};
		},
		{
			name: 'PostedMessageV1Data';
			docs: [
				'Underlying data for either [PostedMessageV1](crate::legacy::state::PostedMessageV1) or',
				'[PostedMessageV1Unreliable](crate::legacy::state::PostedMessageV1Unreliable).',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'info';
						docs: ['Message metadata.'];
						type: {
							defined: 'PostedMessageV1Info';
						};
					},
					{
						name: 'payload';
						docs: ['Encoded message.'];
						type: 'bytes';
					},
				];
			};
		},
		{
			name: 'PostedMessageV1';
			docs: [
				'Account used to store a published Wormhole message.',
				'',
				'NOTE: If your integration requires reusable message accounts, please see',
				'[PostedMessageV1Unreliable](crate::legacy::state::PostedMessageV1Unreliable).',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'data';
						docs: ['Message data.'];
						type: {
							defined: 'PostedMessageV1Data';
						};
					},
				];
			};
		},
		{
			name: 'PostedVaaV1Info';
			docs: [
				'VAA metadata defining information about a Wormhole message attested for by an active guardian',
				'set.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'consistencyLevel';
						docs: ['Level of consistency requested by the emitter.'];
						type: 'u8';
					},
					{
						name: 'timestamp';
						docs: ['Time the message was submitted.'];
						type: {
							defined: 'Timestamp';
						};
					},
					{
						name: 'signatureSet';
						docs: [
							"Pubkey of [SignatureSet](crate::state::SignatureSet) account that represents this VAA's",
							'signature verification.',
						];
						type: 'publicKey';
					},
					{
						name: 'guardianSetIndex';
						docs: [
							'Guardian set index used to verify signatures for [SignatureSet](crate::state::SignatureSet).',
							'',
							'NOTE: In the previous implementation, this member was referred to as the "posted timestamp",',
							'which is zero for VAA data (posted messages and VAAs resemble the same account schema). By',
							'changing this to the guardian set index, we patch a bug with verifying governance VAAs for',
							'the Core Bridge (other Core Bridge implementations require that the guardian set that',
							'attested for the governance VAA is the current one).',
						];
						type: 'u32';
					},
					{
						name: 'nonce';
						docs: ['Unique ID for this message.'];
						type: 'u32';
					},
					{
						name: 'sequence';
						docs: ['Sequence number of this message.'];
						type: 'u64';
					},
					{
						name: 'emitterChain';
						docs: [
							'The Wormhole chain ID denoting the origin of this message.',
						];
						type: 'u16';
					},
					{
						name: 'emitterAddress';
						docs: ['Emitter of the message.'];
						type: {
							array: ['u8', 32];
						};
					},
				];
			};
		},
		{
			name: 'PostedVaaV1';
			docs: ['Account used to store a verified VAA.'];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'info';
						docs: ['VAA metadata.'];
						type: {
							defined: 'PostedVaaV1Info';
						};
					},
					{
						name: 'payload';
						docs: ['Message payload.'];
						type: 'bytes';
					},
				];
			};
		},
		{
			name: 'WriteEncodedVaaArgs';
			docs: [
				'Arguments for the [write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa)',
				'instruction.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'index';
						docs: ['Index of VAA buffer.'];
						type: 'u32';
					},
					{
						name: 'data';
						docs: [
							'Data representing subset of VAA buffer starting at specified index.',
						];
						type: 'bytes';
					},
				];
			};
		},
		{
			name: 'InitMessageV1Args';
			docs: [
				'Arguments for the [init_message_v1](crate::wormhole_core_bridge_solana::init_message_v1)',
				'instruction.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'nonce';
						docs: ['Unique id for this message.'];
						type: 'u32';
					},
					{
						name: 'commitment';
						docs: ['Solana commitment level for Guardian observation.'];
						type: {
							defined: 'Commitment';
						};
					},
					{
						name: 'cpiProgramId';
						docs: [
							'Optional program ID if the emitter address will be your program ID.',
							'',
							'NOTE: If `Some(program_id)`, your emitter authority seeds to be \\[b"emitter\\].',
						];
						type: {
							option: 'publicKey';
						};
					},
				];
			};
		},
		{
			name: 'WriteMessageV1Args';
			docs: [
				'Arguments for the [write_message_v1](crate::wormhole_core_bridge_solana::write_message_v1)',
				'instruction.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'index';
						docs: ['Index of message buffer.'];
						type: 'u32';
					},
					{
						name: 'data';
						docs: [
							'Data representing subset of message buffer starting at specified index.',
						];
						type: 'bytes';
					},
				];
			};
		},
		{
			name: 'Header';
			docs: ['`EncodedVaa` account header.'];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'status';
						docs: [
							'Processing status. **This encoded VAA is only considered usable when this status is set',
							'to [Verified](ProcessingStatus::Verified).**',
						];
						type: {
							defined: 'ProcessingStatus';
						};
					},
					{
						name: 'writeAuthority';
						docs: ['The authority that has write privilege to this account.'];
						type: 'publicKey';
					},
					{
						name: 'version';
						docs: [
							'VAA version. Only when the VAA is verified is this version set to a value.',
						];
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'Timestamp';
			docs: [
				'This struct defines unix timestamp as u32 (as opposed to more modern systems that have adopted',
				"i64). Methods for this struct are meant to convert Solana's clock type to this type assuming we",
				'are far from year 2038.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'value';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'Duration';
			docs: [
				'To be used with the [Timestamp] type, this struct defines a duration in seconds.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'seconds';
						type: 'u32';
					},
				];
			};
		},
		{
			name: 'MessageHash';
			docs: ['This type is used to represent a message hash (keccak).'];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'bytes';
						type: {
							array: ['u8', 32];
						};
					},
				];
			};
		},
		{
			name: 'ChainIdSolanaOnly';
			docs: [
				'This type is kind of silly. But because [PostedMessageV1](crate::state::PostedMessageV1) has the',
				"emitter chain ID as a field, which is unnecessary since it is always Solana's chain ID, we use",
				'this type to guarantee that the encoded chain ID is always `1`.',
			];
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'chainId';
						type: 'u16';
					},
				];
			};
		},
		{
			name: 'EmitterInfo';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'chain';
						type: 'u16';
					},
					{
						name: 'address';
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'sequence';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'LegacyInstruction';
			docs: [
				'Legacy instruction selector.',
				'',
				'NOTE: No more instructions should be added to this enum. Instead, add them as Anchor instruction',
				'handlers, which will inevitably live in',
				'[wormhole_core_bridge_solana](crate::wormhole_core_bridge_solana).',
			];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Initialize';
					},
					{
						name: 'PostMessage';
					},
					{
						name: 'PostVaa';
					},
					{
						name: 'SetMessageFee';
					},
					{
						name: 'TransferFees';
					},
					{
						name: 'UpgradeContract';
					},
					{
						name: 'GuardianSetUpdate';
					},
					{
						name: 'VerifySignatures';
					},
					{
						name: 'PostMessageUnreliable';
					},
				];
			};
		},
		{
			name: 'EmitterType';
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Unset';
					},
					{
						name: 'Legacy';
					},
					{
						name: 'Executable';
					},
				];
			};
		},
		{
			name: 'MessageStatus';
			docs: [
				'Status of a message. When a message is posted, its status is',
				'[Published](MessageStatus::Published).',
			];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Published';
					},
					{
						name: 'Writing';
					},
					{
						name: 'ReadyForPublishing';
					},
				];
			};
		},
		{
			name: 'PublishMessageDirective';
			docs: ['Directive used to determine how to post a Core Bridge message.'];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Message';
						fields: [
							{
								name: 'nonce';
								type: 'u32';
							},
							{
								name: 'payload';
								type: 'bytes';
							},
							{
								name: 'commitment';
								type: {
									defined: 'Commitment';
								};
							},
						];
					},
					{
						name: 'ProgramMessage';
						fields: [
							{
								name: 'programId';
								type: 'publicKey';
							},
							{
								name: 'nonce';
								type: 'u32';
							},
							{
								name: 'payload';
								type: 'bytes';
							},
							{
								name: 'commitment';
								type: {
									defined: 'Commitment';
								};
							},
						];
					},
					{
						name: 'PreparedMessage';
					},
				];
			};
		},
		{
			name: 'ProcessingStatus';
			docs: ["Encoded VAA's processing status."];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Unset';
					},
					{
						name: 'Writing';
					},
					{
						name: 'Verified';
					},
				];
			};
		},
		{
			name: 'Commitment';
			docs: [
				"Representation of Solana's commitment levels. This enum is not exhaustive because Wormhole only",
				'considers these two commitment levels in its Guardian observation.',
				'',
				'See <https://docs.solana.com/cluster/commitments> for more info.',
			];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Confirmed';
					},
					{
						name: 'Finalized';
					},
				];
			};
		},
	];
	errors: [
		{
			code: 6002;
			name: 'InvalidInstructionArgument';
			msg: 'InvalidInstructionArgument';
		},
		{
			code: 6003;
			name: 'AccountNotZeroed';
			msg: 'AccountNotZeroed';
		},
		{
			code: 6004;
			name: 'InvalidDataConversion';
			msg: 'InvalidDataConversion';
		},
		{
			code: 6006;
			name: 'U64Overflow';
			msg: 'U64Overflow';
		},
		{
			code: 6008;
			name: 'InvalidComputeSize';
			msg: 'InvalidComputeSize';
		},
		{
			code: 6016;
			name: 'InvalidChain';
			msg: 'InvalidChain';
		},
		{
			code: 6032;
			name: 'InvalidGovernanceEmitter';
			msg: 'InvalidGovernanceEmitter';
		},
		{
			code: 6034;
			name: 'InvalidGovernanceAction';
			msg: 'InvalidGovernanceAction';
		},
		{
			code: 6036;
			name: 'LatestGuardianSetRequired';
			msg: 'LatestGuardianSetRequired';
		},
		{
			code: 6038;
			name: 'GovernanceForAnotherChain';
			msg: 'GovernanceForAnotherChain';
		},
		{
			code: 6040;
			name: 'InvalidGovernanceVaa';
			msg: 'InvalidGovernanceVaa';
		},
		{
			code: 6256;
			name: 'InsufficientFees';
			msg: 'InsufficientFees';
		},
		{
			code: 6258;
			name: 'EmitterMismatch';
			msg: 'EmitterMismatch';
		},
		{
			code: 6260;
			name: 'NotReadyForPublishing';
			msg: 'NotReadyForPublishing';
		},
		{
			code: 6262;
			name: 'InvalidPreparedMessage';
			msg: 'InvalidPreparedMessage';
		},
		{
			code: 6264;
			name: 'ExecutableEmitter';
			msg: 'ExecutableEmitter';
		},
		{
			code: 6266;
			name: 'LegacyEmitter';
			msg: 'LegacyEmitter';
		},
		{
			code: 6512;
			name: 'InvalidSignatureSet';
			msg: 'InvalidSignatureSet';
		},
		{
			code: 6514;
			name: 'InvalidMessageHash';
			msg: 'InvalidMessageHash';
		},
		{
			code: 6515;
			name: 'NoQuorum';
			msg: 'NoQuorum';
		},
		{
			code: 6516;
			name: 'MessageMismatch';
			msg: 'MessageMismatch';
		},
		{
			code: 7024;
			name: 'NotEnoughLamports';
			msg: 'NotEnoughLamports';
		},
		{
			code: 7026;
			name: 'InvalidFeeRecipient';
			msg: 'InvalidFeeRecipient';
		},
		{
			code: 7280;
			name: 'ImplementationMismatch';
			msg: 'ImplementationMismatch';
		},
		{
			code: 7536;
			name: 'InvalidGuardianSetIndex';
			msg: 'InvalidGuardianSetIndex';
		},
		{
			code: 7792;
			name: 'GuardianSetMismatch';
			msg: 'GuardianSetMismatch';
		},
		{
			code: 7794;
			name: 'InstructionAtWrongIndex';
			msg: 'InstructionAtWrongIndex';
		},
		{
			code: 7795;
			name: 'EmptySigVerifyInstruction';
			msg: 'EmptySigVerifyInstruction';
		},
		{
			code: 7796;
			name: 'InvalidSigVerifyInstruction';
			msg: 'InvalidSigVerifyInstruction';
		},
		{
			code: 7798;
			name: 'GuardianSetExpired';
			msg: 'GuardianSetExpired';
		},
		{
			code: 7800;
			name: 'InvalidGuardianKeyRecovery';
			msg: 'InvalidGuardianKeyRecovery';
		},
		{
			code: 7802;
			name: 'SignerIndicesMismatch';
			msg: 'SignerIndicesMismatch';
		},
		{
			code: 8048;
			name: 'PayloadSizeMismatch';
			msg: 'PayloadSizeMismatch';
		},
		{
			code: 10112;
			name: 'ZeroGuardians';
			msg: 'ZeroGuardians';
		},
		{
			code: 10128;
			name: 'GuardianZeroAddress';
			msg: 'GuardianZeroAddress';
		},
		{
			code: 10144;
			name: 'DuplicateGuardianAddress';
			msg: 'DuplicateGuardianAddress';
		},
		{
			code: 10160;
			name: 'MessageAlreadyPublished';
			msg: 'MessageAlreadyPublished';
		},
		{
			code: 10176;
			name: 'VaaWritingDisallowed';
			msg: 'VaaWritingDisallowed';
		},
		{
			code: 10192;
			name: 'VaaAlreadyVerified';
			msg: 'VaaAlreadyVerified';
		},
		{
			code: 10208;
			name: 'InvalidGuardianIndex';
			msg: 'InvalidGuardianIndex';
		},
		{
			code: 10224;
			name: 'InvalidSignature';
			msg: 'InvalidSignature';
		},
		{
			code: 10256;
			name: 'UnverifiedVaa';
			msg: 'UnverifiedVaa';
		},
		{
			code: 10258;
			name: 'VaaStillProcessing';
			msg: 'VaaStillProcessing';
		},
		{
			code: 10260;
			name: 'InWritingStatus';
			msg: 'InWritingStatus';
		},
		{
			code: 10262;
			name: 'NotInWritingStatus';
			msg: 'NotInWritingStatus';
		},
		{
			code: 10264;
			name: 'InvalidMessageStatus';
			msg: 'InvalidMessageStatus';
		},
		{
			code: 10266;
			name: 'HashNotComputed';
			msg: 'HashNotComputed';
		},
		{
			code: 10268;
			name: 'InvalidVaaVersion';
			msg: 'InvalidVaaVersion';
		},
		{
			code: 10270;
			name: 'InvalidCreatedAccountSize';
			msg: 'InvalidCreatedAccountSize';
		},
		{
			code: 10272;
			name: 'DataOverflow';
			msg: 'DataOverflow';
		},
		{
			code: 10274;
			name: 'ExceedsMaxPayloadSize';
			msg: 'ExceedsMaxPayloadSize (30KB)';
		},
		{
			code: 10276;
			name: 'CannotParseVaa';
			msg: 'CannotParseVaa';
		},
		{
			code: 10278;
			name: 'EmitterAuthorityMismatch';
			msg: 'EmitterAuthorityMismatch';
		},
		{
			code: 10280;
			name: 'InvalidProgramEmitter';
			msg: 'InvalidProgramEmitter';
		},
		{
			code: 10282;
			name: 'WriteAuthorityMismatch';
			msg: 'WriteAuthorityMismatch';
		},
		{
			code: 10284;
			name: 'PostedVaaPayloadTooLarge';
			msg: 'PostedVaaPayloadTooLarge';
		},
		{
			code: 10286;
			name: 'ExecutableDisallowed';
			msg: 'ExecutableDisallowed';
		},
	];
};

export const WORMHOLE_CORE_BRIDGE_SOLANA_IDL: WormholeCoreBridgeSolana = {
	version: '0.0.1-alpha.5',
	name: 'wormhole_core_bridge_solana',
	constants: [
		{
			name: 'SOLANA_CHAIN',
			type: 'u16',
			value: '1',
		},
		{
			name: 'FEE_COLLECTOR_SEED_PREFIX',
			type: 'bytes',
			value: '[102, 101, 101, 95, 99, 111, 108, 108, 101, 99, 116, 111, 114]',
		},
		{
			name: 'UPGRADE_SEED_PREFIX',
			type: 'bytes',
			value: '[117, 112, 103, 114, 97, 100, 101]',
		},
		{
			name: 'PROGRAM_EMITTER_SEED_PREFIX',
			type: 'bytes',
			value: '[101, 109, 105, 116, 116, 101, 114]',
		},
		{
			name: 'MAX_MESSAGE_PAYLOAD_SIZE',
			type: {
				defined: 'usize',
			},
			value: '30 * 1_024',
		},
	],
	instructions: [
		{
			name: 'initMessageV1',
			docs: [
				'Processor for initializing a new draft [PostedMessageV1](crate::state::PostedMessageV1)',
				'account for writing. The emitter authority is established at this point and the payload size',
				'is inferred from the size of the created account. This instruction handler also allows an',
				"integrator to publish Wormhole messages using his program's ID as the emitter address",
				'(by passing `Some(crate::ID)` to the [cpi_program_id](InitMessageV1Args::cpi_program_id)',
				'argument). **Be aware that the emitter authority\'s seeds must only be \\[b"emitter"\\] in this',
				'case.**',
				'',
				'This instruction should be followed up with `write_message_v1` and `finalize_message_v1` to',
				'write and indicate that the message is ready for publishing respectively (to prepare it for',
				'publishing via the',
				'[post message instruction](crate::legacy::instruction::LegacyInstruction::PostMessage)).',
				'',
				'NOTE: If you wish to publish a small message (one where the data does not overflow the',
				'Solana transaction size), it is recommended that you use an [sdk](crate::sdk::cpi) method to',
				'either prepare your message or post a message as a program ID emitter.',
			],
			accounts: [
				{
					name: 'emitterAuthority',
					isMut: false,
					isSigner: true,
					docs: [
						'This authority is the only one who can write to the draft message account.',
					],
				},
				{
					name: 'draftMessage',
					isMut: true,
					isSigner: false,
					docs: ['Bridge.'],
				},
			],
			args: [
				{
					name: 'args',
					type: {
						defined: 'InitMessageV1Args',
					},
				},
			],
		},
		{
			name: 'writeMessageV1',
			docs: [
				'Processor used to write to a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'This instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			],
			accounts: [
				{
					name: 'emitterAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'draftMessage',
					isMut: true,
					isSigner: false,
					docs: ['only be published when the message is finalized.'],
				},
			],
			args: [
				{
					name: 'args',
					type: {
						defined: 'WriteMessageV1Args',
					},
				},
			],
		},
		{
			name: 'finalizeMessageV1',
			docs: [
				'Processor used to finalize a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'Once finalized, this message account cannot be written to again. A finalized message is the',
				'only state the legacy post message instruction can accept before publishing. This',
				'instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			],
			accounts: [
				{
					name: 'emitterAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'draftMessage',
					isMut: true,
					isSigner: false,
					docs: ['only be published when the message is finalized.'],
				},
			],
			args: [],
		},
		{
			name: 'closeMessageV1',
			docs: [
				'Processor used to process a draft [PostedMessageV1](crate::state::PostedMessageV1) account.',
				'This instruction requires an authority (the emitter authority) to interact with the message',
				'account.',
			],
			accounts: [
				{
					name: 'emitterAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'draftMessage',
					isMut: true,
					isSigner: false,
					docs: ['only be published when the message is finalized.'],
				},
				{
					name: 'closeAccountDestination',
					isMut: true,
					isSigner: false,
				},
			],
			args: [],
		},
		{
			name: 'initEncodedVaa',
			docs: [
				'Processor used to intialize a created account as [EncodedVaa](crate::state::EncodedVaa). An',
				'authority (the write authority) is established with this instruction.',
			],
			accounts: [
				{
					name: 'writeAuthority',
					isMut: false,
					isSigner: true,
					docs: [
						'The authority who can write to the VAA account when it is being processed.',
					],
				},
				{
					name: 'encodedVaa',
					isMut: true,
					isSigner: false,
					docs: ['Bridge.'],
				},
			],
			args: [],
		},
		{
			name: 'closeEncodedVaa',
			docs: [
				'Processor used to close an [EncodedVaa](crate::state::EncodedVaa). This instruction requires',
				'an authority (the write authority) to interact witht he encoded VAA account.',
			],
			accounts: [
				{
					name: 'writeAuthority',
					isMut: true,
					isSigner: true,
					docs: [
						'This account is only required to be mutable for the `CloseVaaAccount` directive. This',
						'authority is the same signer that originally created the VAA accounts, so he is the one that',
						'will receive the lamports back for the closed accounts.',
					],
				},
				{
					name: 'encodedVaa',
					isMut: true,
					isSigner: false,
					docs: ['written to and then verified.'],
				},
			],
			args: [],
		},
		{
			name: 'writeEncodedVaa',
			docs: [
				'Processor used to write to an [EncodedVaa](crate::state::EncodedVaa) account. This',
				'instruction requires an authority (the write authority) to interact with the encoded VAA',
				'account.',
			],
			accounts: [
				{
					name: 'writeAuthority',
					isMut: false,
					isSigner: true,
					docs: [
						'The only authority that can write to the encoded VAA account.',
					],
				},
				{
					name: 'draftVaa',
					isMut: true,
					isSigner: false,
					docs: ['written to and then verified.'],
				},
			],
			args: [
				{
					name: 'args',
					type: {
						defined: 'WriteEncodedVaaArgs',
					},
				},
			],
		},
		{
			name: 'verifyEncodedVaaV1',
			docs: [
				'Processor used to verify an [EncodedVaa](crate::state::EncodedVaa) account as a version 1',
				'VAA (guardian signatures attesting to this observation). This instruction requires an',
				'authority (the write authority) to interact with the encoded VAA account.',
			],
			accounts: [
				{
					name: 'writeAuthority',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'draftVaa',
					isMut: true,
					isSigner: false,
					docs: ['written to and then verified.'],
				},
				{
					name: 'guardianSet',
					isMut: false,
					isSigner: false,
					docs: [
						'Guardian set account, which should be the same one that was used to attest for the VAA. The',
						'signatures in the encoded VAA are verified against this guardian set.',
					],
				},
			],
			args: [],
		},
		{
			name: 'postVaaV1',
			docs: [
				'Processor used to close an [EncodedVaa](crate::state::EncodedVaa) account to create a',
				'[PostedMessageV1](crate::state::PostedMessageV1) account in its place.',
				'',
				'NOTE: Because the legacy verify signatures instruction was not required for the Posted VAA',
				'account to exist, the encoded [SignatureSet](crate::state::SignatureSet) is the default',
				'[Pubkey].',
			],
			accounts: [
				{
					name: 'payer',
					isMut: true,
					isSigner: true,
					docs: [
						'Payer to create the posted VAA account. This instruction allows anyone with an encoded VAA',
						'to create a posted VAA account.',
					],
				},
				{
					name: 'encodedVaa',
					isMut: false,
					isSigner: false,
					docs: [
						'Encoded VAA, whose body will be serialized into the posted VAA account.',
						'',
						'NOTE: This instruction handler only exists to support integrators that still rely on posted',
						'VAA accounts. While we encourage integrators to use the encoded VAA account instead, we',
						'allow a pathway to convert the encoded VAA into a posted VAA. However, the payload is',
						'restricted to 9.5KB, which is much larger than what was possible with the old implementation',
						'using the legacy post vaa instruction. The Core Bridge program will not support posting VAAs',
						'larger than this payload size.',
					],
				},
				{
					name: 'postedVaa',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [],
		},
		{
			name: 'closeSignatureSet',
			docs: [
				'Processor used to close a [SignatureSet](crate::state::SignatureSet), which was used to',
				'verify the VAA using the legacy parse and verify procedure.',
			],
			accounts: [
				{
					name: 'solDestination',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'postedVaa',
					isMut: false,
					isSigner: false,
					docs: ['Posted VAA.'],
				},
				{
					name: 'signatureSet',
					isMut: true,
					isSigner: false,
					docs: [
						'Signature set that may have been used to create the posted VAA account. If the `post_vaa_v1`',
						'instruction were used to create the posted VAA account, then the encoded signature set',
						'pubkey would be all zeroes.',
					],
				},
			],
			args: [],
		},
	],
	accounts: [
		{
			name: 'guardianSet',
			docs: [
				'Account used to store a guardian set. The keys encoded in this account are Ethereum pubkeys.',
				'Its expiration time is determined at the time a guardian set is updated to a new set, where the',
				'current network clock time is used with',
				'[guardian_set_ttl](crate::state::Config::guardian_set_ttl).',
				'',
				'NOTE: The account schema is the same as legacy guardian sets, but this account now has a',
				"discriminator generated by Anchor's [account] macro. When the Core Bridge program performs a",
				'guardian set update with this implementation, guardian sets will now have this Anchor-generated',
				'discriminator.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'index',
						docs: [
							'Index representing an incrementing version number for this guardian set.',
						],
						type: 'u32',
					},
					{
						name: 'keys',
						docs: ['Ethereum-style public keys.'],
						type: {
							vec: {
								array: ['u8', 20],
							},
						},
					},
					{
						name: 'creationTime',
						docs: [
							'Timestamp representing the time this guardian became active.',
						],
						type: {
							defined: 'Timestamp',
						},
					},
					{
						name: 'expirationTime',
						docs: [
							'Expiration time when VAAs issued by this set are no longer valid.',
						],
						type: {
							defined: 'Timestamp',
						},
					},
				],
			},
		},
		{
			name: 'signatureSet',
			docs: [
				'Account used to store information about a guardian set used to sign a VAA. There is only one',
				'signature set for each verified VAA (associated with a',
				'[PostedVaaV1](crate::legacy::state::PostedVaaV1) account). This account is created using the',
				'verify signatures legacy instruction.',
				'',
				'NOTE: The account schema is the same as legacy signature sets, but this account now has a',
				"discriminator generated by Anchor's [account] macro. When the Core Bridge program upgrades to",
				'this implementation from the old one, integrators in the middle of verifying signatures will',
				'have to use a new keypair for this account and try again.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'sigVerifySuccesses',
						docs: ['Signatures of validators'],
						type: {
							vec: 'bool',
						},
					},
					{
						name: 'messageHash',
						docs: ['Hash of the VAA message body.'],
						type: {
							defined: 'MessageHash',
						},
					},
					{
						name: 'guardianSetIndex',
						docs: ['Index of the guardian set'],
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'encodedVaa',
			docs: [
				'Account used to warehouse VAA buffer.',
				'',
				"NOTE: This account should not be used by an external application unless the header's status is",
				'`Verified`. It is encouraged to use the `EncodedVaa` zero-copy account struct instead.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'header',
						docs: ['Status, write authority and VAA version.'],
						type: {
							defined: 'Header',
						},
					},
					{
						name: 'buf',
						docs: ['VAA buffer.'],
						type: 'bytes',
					},
				],
			},
		},
	],
	types: [
		{
			name: 'InitializeArgs',
			docs: ['Arguments used to initialize the Core Bridge program.'],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'guardianSetTtlSeconds',
						type: 'u32',
					},
					{
						name: 'feeLamports',
						type: 'u64',
					},
					{
						name: 'initialGuardians',
						type: {
							vec: {
								array: ['u8', 20],
							},
						},
					},
				],
			},
		},
		{
			name: 'PostMessageArgs',
			docs: [
				'Arguments used to post a new Wormhole (Core Bridge) message either using',
				'[post_message](crate::legacy::instruction::post_message) or',
				'[post_message_unreliable](crate::legacy::instruction::post_message_unreliable).',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'nonce',
						docs: ['Unique id for this message.'],
						type: 'u32',
					},
					{
						name: 'payload',
						docs: ['Encoded message.'],
						type: 'bytes',
					},
					{
						name: 'commitment',
						docs: ['Solana commitment level for Guardian observation.'],
						type: {
							defined: 'Commitment',
						},
					},
				],
			},
		},
		{
			name: 'PostVaaArgs',
			docs: [
				'Arguments to post new VAA data after signature verification.',
				'',
				'NOTE: It is preferred to use the new process of verifying a VAA using the new Core Bridge Anchor',
				'instructions. See [init_encoded_vaa](crate::wormhole_core_bridge_solana::init_encoded_vaa) and',
				'[write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa) for more info.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'gap0',
						docs: ['Unused data.'],
						type: {
							array: ['u8', 5],
						},
					},
					{
						name: 'timestamp',
						docs: ['Time the message was submitted.'],
						type: 'u32',
					},
					{
						name: 'nonce',
						docs: ['Unique ID for this message.'],
						type: 'u32',
					},
					{
						name: 'emitterChain',
						docs: [
							'The Wormhole chain ID denoting the origin of this message.',
						],
						type: 'u16',
					},
					{
						name: 'emitterAddress',
						docs: ['Emitter of the message.'],
						type: {
							array: ['u8', 32],
						},
					},
					{
						name: 'sequence',
						docs: ['Sequence number of this message.'],
						type: 'u64',
					},
					{
						name: 'consistencyLevel',
						docs: ['Level of consistency requested by the emitter.'],
						type: 'u8',
					},
					{
						name: 'payload',
						docs: ['Message payload.'],
						type: 'bytes',
					},
				],
			},
		},
		{
			name: 'VerifySignaturesArgs',
			docs: [
				'Arguments to verify specific guardian indices.',
				'',
				'NOTE: It is preferred to use the new process of verifying a VAA using the new Core Bridge Anchor',
				'instructions. See [init_encoded_vaa](crate::wormhole_core_bridge_solana::init_encoded_vaa) and',
				'[write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa) for more info.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'signerIndices',
						docs: [
							'Indices of verified guardian signatures, where -1 indicates a missing value. There is a',
							'missing value if the guardian at this index is not expected to have its signature verfied by',
							'the Sig Verify native program in the instruction invoked prior).',
							'',
							'NOTE: In the legacy implementation, this argument being a fixed-sized array of 19 only',
							'allows the first 19 guardians of any size guardian set to be verified. Because of this, it',
							'is absolutely important to use the new process of verifying a VAA.',
						],
						type: {
							array: ['i8', 19],
						},
					},
				],
			},
		},
		{
			name: 'EmptyArgs',
			docs: ['Unit struct used to represent an empty instruction argument.'],
			type: {
				kind: 'struct',
				fields: [],
			},
		},
		{
			name: 'Config',
			docs: [
				'Account used to store the current configuration of the bridge, including tracking Wormhole fee',
				'payments. For governance decrees, the guardian set index is used to determine whether a decree',
				'was attested for using the latest guardian set.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'guardianSetIndex',
						docs: [
							'The current guardian set index, used to decide which signature sets to accept.',
						],
						type: 'u32',
					},
					{
						name: 'gap0',
						docs: [
							'Gap. In the old implementation, this was an amount that kept track of message fees that',
							"were paid to the program's fee collector.",
						],
						type: {
							array: ['u8', 8],
						},
					},
					{
						name: 'guardianSetTtl',
						docs: [
							'Period for how long a guardian set is valid after it has been replaced by a new one.  This',
							'guarantees that VAAs issued by that set can still be submitted for a certain period.  In',
							'this period we still trust the old guardian set.',
						],
						type: {
							defined: 'Duration',
						},
					},
					{
						name: 'feeLamports',
						docs: [
							'Amount of lamports that needs to be paid to the protocol to post a message',
						],
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'LegacyEmitterSequence',
			docs: [
				'Account used to store the current sequence number for a given emitter.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'value',
						docs: [
							'Current sequence number, which will be used the next time this emitter publishes a message.',
						],
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'EmitterSequence',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'legacy',
						type: {
							defined: 'LegacyEmitterSequence',
						},
					},
					{
						name: 'bump',
						type: 'u8',
					},
					{
						name: 'emitterType',
						type: {
							defined: 'EmitterType',
						},
					},
				],
			},
		},
		{
			name: 'PostedMessageV1Unreliable',
			docs: ['Account used to store a published (reusable) Wormhole message.'],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'data',
						type: {
							defined: 'PostedMessageV1Data',
						},
					},
				],
			},
		},
		{
			name: 'PostedMessageV1Info',
			docs: [
				'Message metadata defining information about a published Wormhole message.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'consistencyLevel',
						docs: ['Level of consistency requested by the emitter.'],
						type: 'u8',
					},
					{
						name: 'emitterAuthority',
						docs: [
							'Authority used to write the message. This field is set to default when the message is',
							'posted.',
						],
						type: 'publicKey',
					},
					{
						name: 'status',
						docs: [
							'If a message is being written to, this status is used to determine which state this',
							'account is in (e.g. [MessageStatus::Writing] indicates that the emitter authority is still',
							'writing its message to this account). When this message is posted, this value will be',
							'set to [MessageStatus::Published].',
						],
						type: {
							defined: 'MessageStatus',
						},
					},
					{
						name: 'gap0',
						docs: ['No data is stored here.'],
						type: {
							array: ['u8', 3],
						},
					},
					{
						name: 'postedTimestamp',
						docs: ['Time the posted message was created.'],
						type: {
							defined: 'Timestamp',
						},
					},
					{
						name: 'nonce',
						docs: ['Unique id for this message.'],
						type: 'u32',
					},
					{
						name: 'sequence',
						docs: ['Sequence number of this message.'],
						type: 'u64',
					},
					{
						name: 'solanaChainId',
						docs: [
							'Always `1`.',
							'',
							'NOTE: Saving this value is silly, but we are keeping it to be consistent with how the posted',
							'message account is written.',
						],
						type: {
							defined: 'ChainIdSolanaOnly',
						},
					},
					{
						name: 'emitter',
						docs: [
							'Emitter of the message. This may either be the emitter authority or a program ID.',
						],
						type: 'publicKey',
					},
				],
			},
		},
		{
			name: 'PostedMessageV1Data',
			docs: [
				'Underlying data for either [PostedMessageV1](crate::legacy::state::PostedMessageV1) or',
				'[PostedMessageV1Unreliable](crate::legacy::state::PostedMessageV1Unreliable).',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'info',
						docs: ['Message metadata.'],
						type: {
							defined: 'PostedMessageV1Info',
						},
					},
					{
						name: 'payload',
						docs: ['Encoded message.'],
						type: 'bytes',
					},
				],
			},
		},
		{
			name: 'PostedMessageV1',
			docs: [
				'Account used to store a published Wormhole message.',
				'',
				'NOTE: If your integration requires reusable message accounts, please see',
				'[PostedMessageV1Unreliable](crate::legacy::state::PostedMessageV1Unreliable).',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'data',
						docs: ['Message data.'],
						type: {
							defined: 'PostedMessageV1Data',
						},
					},
				],
			},
		},
		{
			name: 'PostedVaaV1Info',
			docs: [
				'VAA metadata defining information about a Wormhole message attested for by an active guardian',
				'set.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'consistencyLevel',
						docs: ['Level of consistency requested by the emitter.'],
						type: 'u8',
					},
					{
						name: 'timestamp',
						docs: ['Time the message was submitted.'],
						type: {
							defined: 'Timestamp',
						},
					},
					{
						name: 'signatureSet',
						docs: [
							"Pubkey of [SignatureSet](crate::state::SignatureSet) account that represents this VAA's",
							'signature verification.',
						],
						type: 'publicKey',
					},
					{
						name: 'guardianSetIndex',
						docs: [
							'Guardian set index used to verify signatures for [SignatureSet](crate::state::SignatureSet).',
							'',
							'NOTE: In the previous implementation, this member was referred to as the "posted timestamp",',
							'which is zero for VAA data (posted messages and VAAs resemble the same account schema). By',
							'changing this to the guardian set index, we patch a bug with verifying governance VAAs for',
							'the Core Bridge (other Core Bridge implementations require that the guardian set that',
							'attested for the governance VAA is the current one).',
						],
						type: 'u32',
					},
					{
						name: 'nonce',
						docs: ['Unique ID for this message.'],
						type: 'u32',
					},
					{
						name: 'sequence',
						docs: ['Sequence number of this message.'],
						type: 'u64',
					},
					{
						name: 'emitterChain',
						docs: [
							'The Wormhole chain ID denoting the origin of this message.',
						],
						type: 'u16',
					},
					{
						name: 'emitterAddress',
						docs: ['Emitter of the message.'],
						type: {
							array: ['u8', 32],
						},
					},
				],
			},
		},
		{
			name: 'PostedVaaV1',
			docs: ['Account used to store a verified VAA.'],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'info',
						docs: ['VAA metadata.'],
						type: {
							defined: 'PostedVaaV1Info',
						},
					},
					{
						name: 'payload',
						docs: ['Message payload.'],
						type: 'bytes',
					},
				],
			},
		},
		{
			name: 'WriteEncodedVaaArgs',
			docs: [
				'Arguments for the [write_encoded_vaa](crate::wormhole_core_bridge_solana::write_encoded_vaa)',
				'instruction.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'index',
						docs: ['Index of VAA buffer.'],
						type: 'u32',
					},
					{
						name: 'data',
						docs: [
							'Data representing subset of VAA buffer starting at specified index.',
						],
						type: 'bytes',
					},
				],
			},
		},
		{
			name: 'InitMessageV1Args',
			docs: [
				'Arguments for the [init_message_v1](crate::wormhole_core_bridge_solana::init_message_v1)',
				'instruction.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'nonce',
						docs: ['Unique id for this message.'],
						type: 'u32',
					},
					{
						name: 'commitment',
						docs: ['Solana commitment level for Guardian observation.'],
						type: {
							defined: 'Commitment',
						},
					},
					{
						name: 'cpiProgramId',
						docs: [
							'Optional program ID if the emitter address will be your program ID.',
							'',
							'NOTE: If `Some(program_id)`, your emitter authority seeds to be \\[b"emitter\\].',
						],
						type: {
							option: 'publicKey',
						},
					},
				],
			},
		},
		{
			name: 'WriteMessageV1Args',
			docs: [
				'Arguments for the [write_message_v1](crate::wormhole_core_bridge_solana::write_message_v1)',
				'instruction.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'index',
						docs: ['Index of message buffer.'],
						type: 'u32',
					},
					{
						name: 'data',
						docs: [
							'Data representing subset of message buffer starting at specified index.',
						],
						type: 'bytes',
					},
				],
			},
		},
		{
			name: 'Header',
			docs: ['`EncodedVaa` account header.'],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'status',
						docs: [
							'Processing status. **This encoded VAA is only considered usable when this status is set',
							'to [Verified](ProcessingStatus::Verified).**',
						],
						type: {
							defined: 'ProcessingStatus',
						},
					},
					{
						name: 'writeAuthority',
						docs: ['The authority that has write privilege to this account.'],
						type: 'publicKey',
					},
					{
						name: 'version',
						docs: [
							'VAA version. Only when the VAA is verified is this version set to a value.',
						],
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'Timestamp',
			docs: [
				'This struct defines unix timestamp as u32 (as opposed to more modern systems that have adopted',
				"i64). Methods for this struct are meant to convert Solana's clock type to this type assuming we",
				'are far from year 2038.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'value',
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'Duration',
			docs: [
				'To be used with the [Timestamp] type, this struct defines a duration in seconds.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'seconds',
						type: 'u32',
					},
				],
			},
		},
		{
			name: 'MessageHash',
			docs: ['This type is used to represent a message hash (keccak).'],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'bytes',
						type: {
							array: ['u8', 32],
						},
					},
				],
			},
		},
		{
			name: 'ChainIdSolanaOnly',
			docs: [
				'This type is kind of silly. But because [PostedMessageV1](crate::state::PostedMessageV1) has the',
				"emitter chain ID as a field, which is unnecessary since it is always Solana's chain ID, we use",
				'this type to guarantee that the encoded chain ID is always `1`.',
			],
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'chainId',
						type: 'u16',
					},
				],
			},
		},
		{
			name: 'EmitterInfo',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'chain',
						type: 'u16',
					},
					{
						name: 'address',
						type: {
							array: ['u8', 32],
						},
					},
					{
						name: 'sequence',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'LegacyInstruction',
			docs: [
				'Legacy instruction selector.',
				'',
				'NOTE: No more instructions should be added to this enum. Instead, add them as Anchor instruction',
				'handlers, which will inevitably live in',
				'[wormhole_core_bridge_solana](crate::wormhole_core_bridge_solana).',
			],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Initialize',
					},
					{
						name: 'PostMessage',
					},
					{
						name: 'PostVaa',
					},
					{
						name: 'SetMessageFee',
					},
					{
						name: 'TransferFees',
					},
					{
						name: 'UpgradeContract',
					},
					{
						name: 'GuardianSetUpdate',
					},
					{
						name: 'VerifySignatures',
					},
					{
						name: 'PostMessageUnreliable',
					},
				],
			},
		},
		{
			name: 'EmitterType',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Unset',
					},
					{
						name: 'Legacy',
					},
					{
						name: 'Executable',
					},
				],
			},
		},
		{
			name: 'MessageStatus',
			docs: [
				'Status of a message. When a message is posted, its status is',
				'[Published](MessageStatus::Published).',
			],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Published',
					},
					{
						name: 'Writing',
					},
					{
						name: 'ReadyForPublishing',
					},
				],
			},
		},
		{
			name: 'PublishMessageDirective',
			docs: ['Directive used to determine how to post a Core Bridge message.'],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Message',
						fields: [
							{
								name: 'nonce',
								type: 'u32',
							},
							{
								name: 'payload',
								type: 'bytes',
							},
							{
								name: 'commitment',
								type: {
									defined: 'Commitment',
								},
							},
						],
					},
					{
						name: 'ProgramMessage',
						fields: [
							{
								name: 'programId',
								type: 'publicKey',
							},
							{
								name: 'nonce',
								type: 'u32',
							},
							{
								name: 'payload',
								type: 'bytes',
							},
							{
								name: 'commitment',
								type: {
									defined: 'Commitment',
								},
							},
						],
					},
					{
						name: 'PreparedMessage',
					},
				],
			},
		},
		{
			name: 'ProcessingStatus',
			docs: ["Encoded VAA's processing status."],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Unset',
					},
					{
						name: 'Writing',
					},
					{
						name: 'Verified',
					},
				],
			},
		},
		{
			name: 'Commitment',
			docs: [
				"Representation of Solana's commitment levels. This enum is not exhaustive because Wormhole only",
				'considers these two commitment levels in its Guardian observation.',
				'',
				'See <https://docs.solana.com/cluster/commitments> for more info.',
			],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Confirmed',
					},
					{
						name: 'Finalized',
					},
				],
			},
		},
	],
	errors: [
		{
			code: 6002,
			name: 'InvalidInstructionArgument',
			msg: 'InvalidInstructionArgument',
		},
		{
			code: 6003,
			name: 'AccountNotZeroed',
			msg: 'AccountNotZeroed',
		},
		{
			code: 6004,
			name: 'InvalidDataConversion',
			msg: 'InvalidDataConversion',
		},
		{
			code: 6006,
			name: 'U64Overflow',
			msg: 'U64Overflow',
		},
		{
			code: 6008,
			name: 'InvalidComputeSize',
			msg: 'InvalidComputeSize',
		},
		{
			code: 6016,
			name: 'InvalidChain',
			msg: 'InvalidChain',
		},
		{
			code: 6032,
			name: 'InvalidGovernanceEmitter',
			msg: 'InvalidGovernanceEmitter',
		},
		{
			code: 6034,
			name: 'InvalidGovernanceAction',
			msg: 'InvalidGovernanceAction',
		},
		{
			code: 6036,
			name: 'LatestGuardianSetRequired',
			msg: 'LatestGuardianSetRequired',
		},
		{
			code: 6038,
			name: 'GovernanceForAnotherChain',
			msg: 'GovernanceForAnotherChain',
		},
		{
			code: 6040,
			name: 'InvalidGovernanceVaa',
			msg: 'InvalidGovernanceVaa',
		},
		{
			code: 6256,
			name: 'InsufficientFees',
			msg: 'InsufficientFees',
		},
		{
			code: 6258,
			name: 'EmitterMismatch',
			msg: 'EmitterMismatch',
		},
		{
			code: 6260,
			name: 'NotReadyForPublishing',
			msg: 'NotReadyForPublishing',
		},
		{
			code: 6262,
			name: 'InvalidPreparedMessage',
			msg: 'InvalidPreparedMessage',
		},
		{
			code: 6264,
			name: 'ExecutableEmitter',
			msg: 'ExecutableEmitter',
		},
		{
			code: 6266,
			name: 'LegacyEmitter',
			msg: 'LegacyEmitter',
		},
		{
			code: 6512,
			name: 'InvalidSignatureSet',
			msg: 'InvalidSignatureSet',
		},
		{
			code: 6514,
			name: 'InvalidMessageHash',
			msg: 'InvalidMessageHash',
		},
		{
			code: 6515,
			name: 'NoQuorum',
			msg: 'NoQuorum',
		},
		{
			code: 6516,
			name: 'MessageMismatch',
			msg: 'MessageMismatch',
		},
		{
			code: 7024,
			name: 'NotEnoughLamports',
			msg: 'NotEnoughLamports',
		},
		{
			code: 7026,
			name: 'InvalidFeeRecipient',
			msg: 'InvalidFeeRecipient',
		},
		{
			code: 7280,
			name: 'ImplementationMismatch',
			msg: 'ImplementationMismatch',
		},
		{
			code: 7536,
			name: 'InvalidGuardianSetIndex',
			msg: 'InvalidGuardianSetIndex',
		},
		{
			code: 7792,
			name: 'GuardianSetMismatch',
			msg: 'GuardianSetMismatch',
		},
		{
			code: 7794,
			name: 'InstructionAtWrongIndex',
			msg: 'InstructionAtWrongIndex',
		},
		{
			code: 7795,
			name: 'EmptySigVerifyInstruction',
			msg: 'EmptySigVerifyInstruction',
		},
		{
			code: 7796,
			name: 'InvalidSigVerifyInstruction',
			msg: 'InvalidSigVerifyInstruction',
		},
		{
			code: 7798,
			name: 'GuardianSetExpired',
			msg: 'GuardianSetExpired',
		},
		{
			code: 7800,
			name: 'InvalidGuardianKeyRecovery',
			msg: 'InvalidGuardianKeyRecovery',
		},
		{
			code: 7802,
			name: 'SignerIndicesMismatch',
			msg: 'SignerIndicesMismatch',
		},
		{
			code: 8048,
			name: 'PayloadSizeMismatch',
			msg: 'PayloadSizeMismatch',
		},
		{
			code: 10112,
			name: 'ZeroGuardians',
			msg: 'ZeroGuardians',
		},
		{
			code: 10128,
			name: 'GuardianZeroAddress',
			msg: 'GuardianZeroAddress',
		},
		{
			code: 10144,
			name: 'DuplicateGuardianAddress',
			msg: 'DuplicateGuardianAddress',
		},
		{
			code: 10160,
			name: 'MessageAlreadyPublished',
			msg: 'MessageAlreadyPublished',
		},
		{
			code: 10176,
			name: 'VaaWritingDisallowed',
			msg: 'VaaWritingDisallowed',
		},
		{
			code: 10192,
			name: 'VaaAlreadyVerified',
			msg: 'VaaAlreadyVerified',
		},
		{
			code: 10208,
			name: 'InvalidGuardianIndex',
			msg: 'InvalidGuardianIndex',
		},
		{
			code: 10224,
			name: 'InvalidSignature',
			msg: 'InvalidSignature',
		},
		{
			code: 10256,
			name: 'UnverifiedVaa',
			msg: 'UnverifiedVaa',
		},
		{
			code: 10258,
			name: 'VaaStillProcessing',
			msg: 'VaaStillProcessing',
		},
		{
			code: 10260,
			name: 'InWritingStatus',
			msg: 'InWritingStatus',
		},
		{
			code: 10262,
			name: 'NotInWritingStatus',
			msg: 'NotInWritingStatus',
		},
		{
			code: 10264,
			name: 'InvalidMessageStatus',
			msg: 'InvalidMessageStatus',
		},
		{
			code: 10266,
			name: 'HashNotComputed',
			msg: 'HashNotComputed',
		},
		{
			code: 10268,
			name: 'InvalidVaaVersion',
			msg: 'InvalidVaaVersion',
		},
		{
			code: 10270,
			name: 'InvalidCreatedAccountSize',
			msg: 'InvalidCreatedAccountSize',
		},
		{
			code: 10272,
			name: 'DataOverflow',
			msg: 'DataOverflow',
		},
		{
			code: 10274,
			name: 'ExceedsMaxPayloadSize',
			msg: 'ExceedsMaxPayloadSize (30KB)',
		},
		{
			code: 10276,
			name: 'CannotParseVaa',
			msg: 'CannotParseVaa',
		},
		{
			code: 10278,
			name: 'EmitterAuthorityMismatch',
			msg: 'EmitterAuthorityMismatch',
		},
		{
			code: 10280,
			name: 'InvalidProgramEmitter',
			msg: 'InvalidProgramEmitter',
		},
		{
			code: 10282,
			name: 'WriteAuthorityMismatch',
			msg: 'WriteAuthorityMismatch',
		},
		{
			code: 10284,
			name: 'PostedVaaPayloadTooLarge',
			msg: 'PostedVaaPayloadTooLarge',
		},
		{
			code: 10286,
			name: 'ExecutableDisallowed',
			msg: 'ExecutableDisallowed',
		},
	],
};

export type PythSolanaReceiver = {
	version: '0.1.0';
	name: 'pyth_solana_receiver';
	instructions: [
		{
			name: 'initialize';
			accounts: [
				{
					name: 'payer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'initialConfig';
					type: {
						defined: 'Config';
					};
				},
			];
		},
		{
			name: 'requestGovernanceAuthorityTransfer';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'targetGovernanceAuthority';
					type: 'publicKey';
				},
			];
		},
		{
			name: 'acceptGovernanceAuthorityTransfer';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [];
		},
		{
			name: 'setDataSources';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'validDataSources';
					type: {
						vec: {
							defined: 'DataSource';
						};
					};
				},
			];
		},
		{
			name: 'setFee';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'singleUpdateFeeInLamports';
					type: 'u64';
				},
			];
		},
		{
			name: 'setWormholeAddress';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'wormhole';
					type: 'publicKey';
				},
			];
		},
		{
			name: 'setMinimumSignatures';
			accounts: [
				{
					name: 'payer';
					isMut: false;
					isSigner: true;
				},
				{
					name: 'config';
					isMut: true;
					isSigner: false;
				},
			];
			args: [
				{
					name: 'minimumSignatures';
					type: 'u8';
				},
			];
		},
		{
			name: 'postUpdateAtomic';
			docs: [
				'Post a price update using a VAA and a MerklePriceUpdate.',
				'This function allows you to post a price update in a single transaction.',
				"Compared to post_update, it is less secure since you won't be able to verify all guardian signatures if you use this function because of transaction size limitations.",
				'Typically, you can fit 5 guardian signatures in a transaction that uses this.',
			];
			accounts: [
				{
					name: 'payer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'guardianSet';
					isMut: false;
					isSigner: false;
					docs: [
						'Instead we do the same steps in deserialize_guardian_set_checked.',
					];
				},
				{
					name: 'config';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'treasury';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'priceUpdateAccount';
					isMut: true;
					isSigner: true;
					docs: [
						'The contraint is such that either the price_update_account is uninitialized or the payer is the write_authority.',
						"Pubkey::default() is the SystemProgram on Solana and it can't sign so it's impossible that price_update_account.write_authority == Pubkey::default() once the account is initialized",
					];
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'writeAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: 'PostUpdateAtomicParams';
					};
				},
			];
		},
		{
			name: 'postUpdate';
			docs: [
				'Post a price update using an encoded_vaa account and a MerklePriceUpdate calldata.',
				'This should be called after the client has already verified the Vaa via the Wormhole contract.',
				'Check out target_chains/solana/cli/src/main.rs for an example of how to do this.',
			];
			accounts: [
				{
					name: 'payer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'encodedVaa';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'config';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'treasury';
					isMut: true;
					isSigner: false;
				},
				{
					name: 'priceUpdateAccount';
					isMut: true;
					isSigner: true;
					docs: [
						'The contraint is such that either the price_update_account is uninitialized or the payer is the write_authority.',
						"Pubkey::default() is the SystemProgram on Solana and it can't sign so it's impossible that price_update_account.write_authority == Pubkey::default() once the account is initialized",
					];
				},
				{
					name: 'systemProgram';
					isMut: false;
					isSigner: false;
				},
				{
					name: 'writeAuthority';
					isMut: false;
					isSigner: true;
				},
			];
			args: [
				{
					name: 'params';
					type: {
						defined: 'PostUpdateParams';
					};
				},
			];
		},
		{
			name: 'reclaimRent';
			accounts: [
				{
					name: 'payer';
					isMut: true;
					isSigner: true;
				},
				{
					name: 'priceUpdateAccount';
					isMut: true;
					isSigner: false;
				},
			];
			args: [];
		},
	];
	accounts: [
		{
			name: 'Config';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'governanceAuthority';
						type: 'publicKey';
					},
					{
						name: 'targetGovernanceAuthority';
						type: {
							option: 'publicKey';
						};
					},
					{
						name: 'wormhole';
						type: 'publicKey';
					},
					{
						name: 'validDataSources';
						type: {
							vec: {
								defined: 'DataSource';
							};
						};
					},
					{
						name: 'singleUpdateFeeInLamports';
						type: 'u64';
					},
					{
						name: 'minimumSignatures';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'priceUpdateV2';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'writeAuthority';
						type: 'publicKey';
					},
					{
						name: 'verificationLevel';
						type: {
							defined: 'VerificationLevel';
						};
					},
					{
						name: 'priceMessage';
						type: {
							defined: 'PriceFeedMessage';
						};
					},
					{
						name: 'postedSlot';
						type: 'u64';
					},
				];
			};
		},
	];
	types: [
		{
			name: 'PriceFeedMessage';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'feedId';
						type: {
							array: ['u8', 32];
						};
					},
					{
						name: 'price';
						type: 'i64';
					},
					{
						name: 'conf';
						type: 'u64';
					},
					{
						name: 'exponent';
						type: 'i32';
					},
					{
						name: 'publishTime';
						type: 'i64';
					},
					{
						name: 'prevPublishTime';
						type: 'i64';
					},
					{
						name: 'emaPrice';
						type: 'i64';
					},
					{
						name: 'emaConf';
						type: 'u64';
					},
				];
			};
		},
		{
			name: 'MerklePriceUpdate';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'message';
						type: 'bytes';
					},
					{
						name: 'proof';
						type: {
							vec: {
								array: ['u8', 20];
							};
						};
					},
				];
			};
		},
		{
			name: 'DataSource';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'chain';
						type: 'u16';
					},
					{
						name: 'emitter';
						type: 'publicKey';
					},
				];
			};
		},
		{
			name: 'PostUpdateAtomicParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'vaa';
						type: 'bytes';
					},
					{
						name: 'merklePriceUpdate';
						type: {
							defined: 'MerklePriceUpdate';
						};
					},
					{
						name: 'treasuryId';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'PostUpdateParams';
			type: {
				kind: 'struct';
				fields: [
					{
						name: 'merklePriceUpdate';
						type: {
							defined: 'MerklePriceUpdate';
						};
					},
					{
						name: 'treasuryId';
						type: 'u8';
					},
				];
			};
		},
		{
			name: 'VerificationLevel';
			docs: [
				'* This enum represents how many guardian signatures were checked for a Pythnet price update\n * If full, guardian quorum has been attained\n * If partial, at least config.minimum signatures have been verified, but in the case config.minimum_signatures changes in the future we also include the number of signatures that were checked',
			];
			type: {
				kind: 'enum';
				variants: [
					{
						name: 'Partial';
						fields: [
							{
								name: 'numSignatures';
								type: 'u8';
							},
						];
					},
					{
						name: 'Full';
					},
				];
			};
		},
	];
	errors: [
		{
			code: 6000;
			name: 'InvalidWormholeMessage';
			msg: 'Received an invalid wormhole message';
		},
		{
			code: 6001;
			name: 'DeserializeMessageFailed';
			msg: 'An error occurred when deserializing the message';
		},
		{
			code: 6002;
			name: 'InvalidPriceUpdate';
			msg: 'Received an invalid price update';
		},
		{
			code: 6003;
			name: 'UnsupportedMessageType';
			msg: 'This type of message is not supported currently';
		},
		{
			code: 6004;
			name: 'InvalidDataSource';
			msg: "The tuple emitter chain, emitter doesn't match one of the valid data sources.";
		},
		{
			code: 6005;
			name: 'InsufficientFunds';
			msg: 'Funds are insufficient to pay the receiving fee';
		},
		{
			code: 6006;
			name: 'WrongWriteAuthority';
			msg: "This signer can't write to price update account";
		},
		{
			code: 6007;
			name: 'WrongVaaOwner';
			msg: 'The posted VAA account has the wrong owner.';
		},
		{
			code: 6008;
			name: 'DeserializeVaaFailed';
			msg: 'An error occurred when deserializing the VAA.';
		},
		{
			code: 6009;
			name: 'InsufficientGuardianSignatures';
			msg: 'The number of guardian signatures is below the minimum';
		},
		{
			code: 6010;
			name: 'InvalidVaaVersion';
			msg: 'Invalid VAA version';
		},
		{
			code: 6011;
			name: 'GuardianSetMismatch';
			msg: "Guardian set version in the VAA doesn't match the guardian set passed";
		},
		{
			code: 6012;
			name: 'InvalidGuardianOrder';
			msg: 'Guardian signature indices must be increasing';
		},
		{
			code: 6013;
			name: 'InvalidGuardianIndex';
			msg: 'Guardian index exceeds the number of guardians in the set';
		},
		{
			code: 6014;
			name: 'InvalidSignature';
			msg: 'A VAA signature is invalid';
		},
		{
			code: 6015;
			name: 'InvalidGuardianKeyRecovery';
			msg: "The recovered guardian public key doesn't match the guardian set";
		},
		{
			code: 6016;
			name: 'WrongGuardianSetOwner';
			msg: 'The guardian set account is owned by the wrong program';
		},
		{
			code: 6017;
			name: 'InvalidGuardianSetPda';
			msg: "The Guardian Set account doesn't match the PDA derivation";
		},
		{
			code: 6018;
			name: 'GuardianSetExpired';
			msg: 'The Guardian Set is expired';
		},
		{
			code: 6019;
			name: 'GovernanceAuthorityMismatch';
			msg: 'The signer is not authorized to perform this governance action';
		},
		{
			code: 6020;
			name: 'TargetGovernanceAuthorityMismatch';
			msg: 'The signer is not authorized to accept the governance authority';
		},
		{
			code: 6021;
			name: 'NonexistentGovernanceAuthorityTransferRequest';
			msg: 'The governance authority needs to request a transfer first';
		},
	];
};

export const IDL: PythSolanaReceiver = {
	version: '0.1.0',
	name: 'pyth_solana_receiver',
	instructions: [
		{
			name: 'initialize',
			accounts: [
				{
					name: 'payer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'initialConfig',
					type: {
						defined: 'Config',
					},
				},
			],
		},
		{
			name: 'requestGovernanceAuthorityTransfer',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'targetGovernanceAuthority',
					type: 'publicKey',
				},
			],
		},
		{
			name: 'acceptGovernanceAuthorityTransfer',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [],
		},
		{
			name: 'setDataSources',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'validDataSources',
					type: {
						vec: {
							defined: 'DataSource',
						},
					},
				},
			],
		},
		{
			name: 'setFee',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'singleUpdateFeeInLamports',
					type: 'u64',
				},
			],
		},
		{
			name: 'setWormholeAddress',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'wormhole',
					type: 'publicKey',
				},
			],
		},
		{
			name: 'setMinimumSignatures',
			accounts: [
				{
					name: 'payer',
					isMut: false,
					isSigner: true,
				},
				{
					name: 'config',
					isMut: true,
					isSigner: false,
				},
			],
			args: [
				{
					name: 'minimumSignatures',
					type: 'u8',
				},
			],
		},
		{
			name: 'postUpdateAtomic',
			docs: [
				'Post a price update using a VAA and a MerklePriceUpdate.',
				'This function allows you to post a price update in a single transaction.',
				"Compared to post_update, it is less secure since you won't be able to verify all guardian signatures if you use this function because of transaction size limitations.",
				'Typically, you can fit 5 guardian signatures in a transaction that uses this.',
			],
			accounts: [
				{
					name: 'payer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'guardianSet',
					isMut: false,
					isSigner: false,
					docs: [
						'Instead we do the same steps in deserialize_guardian_set_checked.',
					],
				},
				{
					name: 'config',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'treasury',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'priceUpdateAccount',
					isMut: true,
					isSigner: true,
					docs: [
						'The contraint is such that either the price_update_account is uninitialized or the payer is the write_authority.',
						"Pubkey::default() is the SystemProgram on Solana and it can't sign so it's impossible that price_update_account.write_authority == Pubkey::default() once the account is initialized",
					],
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'writeAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'params',
					type: {
						defined: 'PostUpdateAtomicParams',
					},
				},
			],
		},
		{
			name: 'postUpdate',
			docs: [
				'Post a price update using an encoded_vaa account and a MerklePriceUpdate calldata.',
				'This should be called after the client has already verified the Vaa via the Wormhole contract.',
				'Check out target_chains/solana/cli/src/main.rs for an example of how to do this.',
			],
			accounts: [
				{
					name: 'payer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'encodedVaa',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'config',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'treasury',
					isMut: true,
					isSigner: false,
				},
				{
					name: 'priceUpdateAccount',
					isMut: true,
					isSigner: true,
					docs: [
						'The contraint is such that either the price_update_account is uninitialized or the payer is the write_authority.',
						"Pubkey::default() is the SystemProgram on Solana and it can't sign so it's impossible that price_update_account.write_authority == Pubkey::default() once the account is initialized",
					],
				},
				{
					name: 'systemProgram',
					isMut: false,
					isSigner: false,
				},
				{
					name: 'writeAuthority',
					isMut: false,
					isSigner: true,
				},
			],
			args: [
				{
					name: 'params',
					type: {
						defined: 'PostUpdateParams',
					},
				},
			],
		},
		{
			name: 'reclaimRent',
			accounts: [
				{
					name: 'payer',
					isMut: true,
					isSigner: true,
				},
				{
					name: 'priceUpdateAccount',
					isMut: true,
					isSigner: false,
				},
			],
			args: [],
		},
	],
	accounts: [
		{
			name: 'Config',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'governanceAuthority',
						type: 'publicKey',
					},
					{
						name: 'targetGovernanceAuthority',
						type: {
							option: 'publicKey',
						},
					},
					{
						name: 'wormhole',
						type: 'publicKey',
					},
					{
						name: 'validDataSources',
						type: {
							vec: {
								defined: 'DataSource',
							},
						},
					},
					{
						name: 'singleUpdateFeeInLamports',
						type: 'u64',
					},
					{
						name: 'minimumSignatures',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'priceUpdateV2',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'writeAuthority',
						type: 'publicKey',
					},
					{
						name: 'verificationLevel',
						type: {
							defined: 'VerificationLevel',
						},
					},
					{
						name: 'priceMessage',
						type: {
							defined: 'PriceFeedMessage',
						},
					},
					{
						name: 'postedSlot',
						type: 'u64',
					},
				],
			},
		},
	],
	types: [
		{
			name: 'PriceFeedMessage',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'feedId',
						type: {
							array: ['u8', 32],
						},
					},
					{
						name: 'price',
						type: 'i64',
					},
					{
						name: 'conf',
						type: 'u64',
					},
					{
						name: 'exponent',
						type: 'i32',
					},
					{
						name: 'publishTime',
						type: 'i64',
					},
					{
						name: 'prevPublishTime',
						type: 'i64',
					},
					{
						name: 'emaPrice',
						type: 'i64',
					},
					{
						name: 'emaConf',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'MerklePriceUpdate',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'message',
						type: 'bytes',
					},
					{
						name: 'proof',
						type: {
							vec: {
								array: ['u8', 20],
							},
						},
					},
				],
			},
		},
		{
			name: 'DataSource',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'chain',
						type: 'u16',
					},
					{
						name: 'emitter',
						type: 'publicKey',
					},
				],
			},
		},
		{
			name: 'PostUpdateAtomicParams',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'vaa',
						type: 'bytes',
					},
					{
						name: 'merklePriceUpdate',
						type: {
							defined: 'MerklePriceUpdate',
						},
					},
					{
						name: 'treasuryId',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'PostUpdateParams',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'merklePriceUpdate',
						type: {
							defined: 'MerklePriceUpdate',
						},
					},
					{
						name: 'treasuryId',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'VerificationLevel',
			docs: [
				'* This enum represents how many guardian signatures were checked for a Pythnet price update\n * If full, guardian quorum has been attained\n * If partial, at least config.minimum signatures have been verified, but in the case config.minimum_signatures changes in the future we also include the number of signatures that were checked',
			],
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Partial',
						fields: [
							{
								name: 'numSignatures',
								type: 'u8',
							},
						],
					},
					{
						name: 'Full',
					},
				],
			},
		},
	],
	errors: [
		{
			code: 6000,
			name: 'InvalidWormholeMessage',
			msg: 'Received an invalid wormhole message',
		},
		{
			code: 6001,
			name: 'DeserializeMessageFailed',
			msg: 'An error occurred when deserializing the message',
		},
		{
			code: 6002,
			name: 'InvalidPriceUpdate',
			msg: 'Received an invalid price update',
		},
		{
			code: 6003,
			name: 'UnsupportedMessageType',
			msg: 'This type of message is not supported currently',
		},
		{
			code: 6004,
			name: 'InvalidDataSource',
			msg: "The tuple emitter chain, emitter doesn't match one of the valid data sources.",
		},
		{
			code: 6005,
			name: 'InsufficientFunds',
			msg: 'Funds are insufficient to pay the receiving fee',
		},
		{
			code: 6006,
			name: 'WrongWriteAuthority',
			msg: "This signer can't write to price update account",
		},
		{
			code: 6007,
			name: 'WrongVaaOwner',
			msg: 'The posted VAA account has the wrong owner.',
		},
		{
			code: 6008,
			name: 'DeserializeVaaFailed',
			msg: 'An error occurred when deserializing the VAA.',
		},
		{
			code: 6009,
			name: 'InsufficientGuardianSignatures',
			msg: 'The number of guardian signatures is below the minimum',
		},
		{
			code: 6010,
			name: 'InvalidVaaVersion',
			msg: 'Invalid VAA version',
		},
		{
			code: 6011,
			name: 'GuardianSetMismatch',
			msg: "Guardian set version in the VAA doesn't match the guardian set passed",
		},
		{
			code: 6012,
			name: 'InvalidGuardianOrder',
			msg: 'Guardian signature indices must be increasing',
		},
		{
			code: 6013,
			name: 'InvalidGuardianIndex',
			msg: 'Guardian index exceeds the number of guardians in the set',
		},
		{
			code: 6014,
			name: 'InvalidSignature',
			msg: 'A VAA signature is invalid',
		},
		{
			code: 6015,
			name: 'InvalidGuardianKeyRecovery',
			msg: "The recovered guardian public key doesn't match the guardian set",
		},
		{
			code: 6016,
			name: 'WrongGuardianSetOwner',
			msg: 'The guardian set account is owned by the wrong program',
		},
		{
			code: 6017,
			name: 'InvalidGuardianSetPda',
			msg: "The Guardian Set account doesn't match the PDA derivation",
		},
		{
			code: 6018,
			name: 'GuardianSetExpired',
			msg: 'The Guardian Set is expired',
		},
		{
			code: 6019,
			name: 'GovernanceAuthorityMismatch',
			msg: 'The signer is not authorized to perform this governance action',
		},
		{
			code: 6020,
			name: 'TargetGovernanceAuthorityMismatch',
			msg: 'The signer is not authorized to accept the governance authority',
		},
		{
			code: 6021,
			name: 'NonexistentGovernanceAuthorityTransferRequest',
			msg: 'The governance authority needs to request a transfer first',
		},
	],
};

export declare const PYTH_SOLANA_RECEIVER_IDL: PythSolanaReceiver;
//# sourceMappingURL=pyth_solana_receiver.d.ts.map

export type PriceUpdateAccount =
	IdlAccounts<PythSolanaReceiver>['priceUpdateV2'];
