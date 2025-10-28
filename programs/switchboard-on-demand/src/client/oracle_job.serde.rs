// @generated
impl serde::Serialize for OracleJob {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.tasks.is_empty() {
            len += 1;
        }
        if self.weight.is_some() {
            len += 1;
        }
        if self.min_responses.is_some() {
            len += 1;
        }
        if self.min_samples.is_some() {
            len += 1;
        }
        if self.max_variance.is_some() {
            len += 1;
        }
        if self.name.is_some() {
            len += 1;
        }
        if self.queue.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob", len)?;
        if !self.tasks.is_empty() {
            struct_ser.serialize_field("tasks", &self.tasks)?;
        }
        if let Some(v) = self.weight.as_ref() {
            struct_ser.serialize_field("weight", v)?;
        }
        if let Some(v) = self.min_responses.as_ref() {
            struct_ser.serialize_field("minResponses", v)?;
        }
        if let Some(v) = self.min_samples.as_ref() {
            struct_ser.serialize_field("minSamples", v)?;
        }
        if let Some(v) = self.max_variance.as_ref() {
            #[allow(clippy::needless_borrow)]
            struct_ser.serialize_field("maxVariance", ToString::to_string(&v).as_str())?;
        }
        if let Some(v) = self.name.as_ref() {
            struct_ser.serialize_field("name", v)?;
        }
        if let Some(v) = self.queue.as_ref() {
            struct_ser.serialize_field("queue", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for OracleJob {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "tasks",
            "weight",
            "min_responses",
            "minResponses",
            "min_samples",
            "minSamples",
            "max_variance",
            "maxVariance",
            "name",
            "queue",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Tasks,
            Weight,
            MinResponses,
            MinSamples,
            MaxVariance,
            Name,
            Queue,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tasks" => Ok(GeneratedField::Tasks),
                            "weight" => Ok(GeneratedField::Weight),
                            "minResponses" | "min_responses" => Ok(GeneratedField::MinResponses),
                            "minSamples" | "min_samples" => Ok(GeneratedField::MinSamples),
                            "maxVariance" | "max_variance" => Ok(GeneratedField::MaxVariance),
                            "name" => Ok(GeneratedField::Name),
                            "queue" => Ok(GeneratedField::Queue),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = OracleJob;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<OracleJob, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut tasks__ = None;
                let mut weight__ = None;
                let mut min_responses__ = None;
                let mut min_samples__ = None;
                let mut max_variance__ = None;
                let mut name__ = None;
                let mut queue__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Tasks => {
                            if tasks__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tasks"));
                            }
                            tasks__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Weight => {
                            if weight__.is_some() {
                                return Err(serde::de::Error::duplicate_field("weight"));
                            }
                            weight__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MinResponses => {
                            if min_responses__.is_some() {
                                return Err(serde::de::Error::duplicate_field("minResponses"));
                            }
                            min_responses__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MinSamples => {
                            if min_samples__.is_some() {
                                return Err(serde::de::Error::duplicate_field("minSamples"));
                            }
                            min_samples__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MaxVariance => {
                            if max_variance__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxVariance"));
                            }
                            max_variance__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Name => {
                            if name__.is_some() {
                                return Err(serde::de::Error::duplicate_field("name"));
                            }
                            name__ = map_.next_value()?;
                        }
                        GeneratedField::Queue => {
                            if queue__.is_some() {
                                return Err(serde::de::Error::duplicate_field("queue"));
                            }
                            queue__ = map_.next_value()?;
                        }
                    }
                }
                Ok(OracleJob {
                    tasks: tasks__.unwrap_or_default(),
                    weight: weight__,
                    min_responses: min_responses__,
                    min_samples: min_samples__,
                    max_variance: max_variance__,
                    name: name__,
                    queue: queue__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::AddTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.addition.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.AddTask", len)?;
        if let Some(v) = self.addition.as_ref() {
            match v {
                oracle_job::add_task::Addition::Scalar(v) => {
                    struct_ser.serialize_field("scalar", v)?;
                }
                oracle_job::add_task::Addition::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::add_task::Addition::Job(v) => {
                    struct_ser.serialize_field("job", v)?;
                }
                oracle_job::add_task::Addition::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::AddTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "scalar",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "job",
            "big",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Scalar,
            AggregatorPubkey,
            Job,
            Big,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "scalar" => Ok(GeneratedField::Scalar),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "job" => Ok(GeneratedField::Job),
                            "big" => Ok(GeneratedField::Big),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::AddTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.AddTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::AddTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut addition__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Scalar => {
                            if addition__.is_some() {
                                return Err(serde::de::Error::duplicate_field("scalar"));
                            }
                            addition__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::add_task::Addition::Scalar(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if addition__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            addition__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::add_task::Addition::AggregatorPubkey);
                        }
                        GeneratedField::Job => {
                            if addition__.is_some() {
                                return Err(serde::de::Error::duplicate_field("job"));
                            }
                            addition__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::add_task::Addition::Job)
;
                        }
                        GeneratedField::Big => {
                            if addition__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            addition__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::add_task::Addition::Big);
                        }
                    }
                }
                Ok(oracle_job::AddTask {
                    addition: addition__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.AddTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::AftermathTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.in_amount.is_some() {
            len += 1;
        }
        if self.in_coin_type.is_some() {
            len += 1;
        }
        if self.out_coin_type.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.AftermathTask", len)?;
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.in_amount.as_ref() {
            struct_ser.serialize_field("inAmount", v)?;
        }
        if let Some(v) = self.in_coin_type.as_ref() {
            struct_ser.serialize_field("inCoinType", v)?;
        }
        if let Some(v) = self.out_coin_type.as_ref() {
            struct_ser.serialize_field("outCoinType", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::AftermathTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pool_address",
            "poolAddress",
            "in_amount",
            "inAmount",
            "in_coin_type",
            "inCoinType",
            "out_coin_type",
            "outCoinType",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PoolAddress,
            InAmount,
            InCoinType,
            OutCoinType,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "inAmount" | "in_amount" => Ok(GeneratedField::InAmount),
                            "inCoinType" | "in_coin_type" => Ok(GeneratedField::InCoinType),
                            "outCoinType" | "out_coin_type" => Ok(GeneratedField::OutCoinType),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::AftermathTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.AftermathTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::AftermathTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pool_address__ = None;
                let mut in_amount__ = None;
                let mut in_coin_type__ = None;
                let mut out_coin_type__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::InAmount => {
                            if in_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inAmount"));
                            }
                            in_amount__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::InCoinType => {
                            if in_coin_type__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inCoinType"));
                            }
                            in_coin_type__ = map_.next_value()?;
                        }
                        GeneratedField::OutCoinType => {
                            if out_coin_type__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outCoinType"));
                            }
                            out_coin_type__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::AftermathTask {
                    pool_address: pool_address__,
                    in_amount: in_amount__,
                    in_coin_type: in_coin_type__,
                    out_coin_type: out_coin_type__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.AftermathTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::AnchorFetchTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.program_id.is_some() {
            len += 1;
        }
        if self.account_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.AnchorFetchTask", len)?;
        if let Some(v) = self.program_id.as_ref() {
            struct_ser.serialize_field("programId", v)?;
        }
        if let Some(v) = self.account_address.as_ref() {
            struct_ser.serialize_field("accountAddress", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::AnchorFetchTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "program_id",
            "programId",
            "account_address",
            "accountAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            ProgramId,
            AccountAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "programId" | "program_id" => Ok(GeneratedField::ProgramId),
                            "accountAddress" | "account_address" => Ok(GeneratedField::AccountAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::AnchorFetchTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.AnchorFetchTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::AnchorFetchTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut program_id__ = None;
                let mut account_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::ProgramId => {
                            if program_id__.is_some() {
                                return Err(serde::de::Error::duplicate_field("programId"));
                            }
                            program_id__ = map_.next_value()?;
                        }
                        GeneratedField::AccountAddress => {
                            if account_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("accountAddress"));
                            }
                            account_address__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::AnchorFetchTask {
                    program_id: program_id__,
                    account_address: account_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.AnchorFetchTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::BitFluxTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.provider.is_some() {
            len += 1;
        }
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.in_token.is_some() {
            len += 1;
        }
        if self.out_token.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.BitFluxTask", len)?;
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.in_token.as_ref() {
            struct_ser.serialize_field("inToken", v)?;
        }
        if let Some(v) = self.out_token.as_ref() {
            struct_ser.serialize_field("outToken", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::BitFluxTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "provider",
            "pool_address",
            "poolAddress",
            "in_token",
            "inToken",
            "out_token",
            "outToken",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Provider,
            PoolAddress,
            InToken,
            OutToken,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "provider" => Ok(GeneratedField::Provider),
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "inToken" | "in_token" => Ok(GeneratedField::InToken),
                            "outToken" | "out_token" => Ok(GeneratedField::OutToken),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::BitFluxTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.BitFluxTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::BitFluxTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut provider__ = None;
                let mut pool_address__ = None;
                let mut in_token__ = None;
                let mut out_token__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::InToken => {
                            if in_token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inToken"));
                            }
                            in_token__ = map_.next_value()?;
                        }
                        GeneratedField::OutToken => {
                            if out_token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outToken"));
                            }
                            out_token__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::BitFluxTask {
                    provider: provider__,
                    pool_address: pool_address__,
                    in_token: in_token__,
                    out_token: out_token__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.BitFluxTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::BoundTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.lower_bound.is_some() {
            len += 1;
        }
        if self.lower_bound_value.is_some() {
            len += 1;
        }
        if self.upper_bound.is_some() {
            len += 1;
        }
        if self.upper_bound_value.is_some() {
            len += 1;
        }
        if self.on_exceeds_upper_bound.is_some() {
            len += 1;
        }
        if self.on_exceeds_upper_bound_value.is_some() {
            len += 1;
        }
        if self.on_exceeds_lower_bound.is_some() {
            len += 1;
        }
        if self.on_exceeds_lower_bound_value.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.BoundTask", len)?;
        if let Some(v) = self.lower_bound.as_ref() {
            struct_ser.serialize_field("lowerBound", v)?;
        }
        if let Some(v) = self.lower_bound_value.as_ref() {
            struct_ser.serialize_field("lowerBoundValue", v)?;
        }
        if let Some(v) = self.upper_bound.as_ref() {
            struct_ser.serialize_field("upperBound", v)?;
        }
        if let Some(v) = self.upper_bound_value.as_ref() {
            struct_ser.serialize_field("upperBoundValue", v)?;
        }
        if let Some(v) = self.on_exceeds_upper_bound.as_ref() {
            struct_ser.serialize_field("onExceedsUpperBound", v)?;
        }
        if let Some(v) = self.on_exceeds_upper_bound_value.as_ref() {
            struct_ser.serialize_field("onExceedsUpperBoundValue", v)?;
        }
        if let Some(v) = self.on_exceeds_lower_bound.as_ref() {
            struct_ser.serialize_field("onExceedsLowerBound", v)?;
        }
        if let Some(v) = self.on_exceeds_lower_bound_value.as_ref() {
            struct_ser.serialize_field("onExceedsLowerBoundValue", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::BoundTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "lower_bound",
            "lowerBound",
            "lower_bound_value",
            "lowerBoundValue",
            "upper_bound",
            "upperBound",
            "upper_bound_value",
            "upperBoundValue",
            "on_exceeds_upper_bound",
            "onExceedsUpperBound",
            "on_exceeds_upper_bound_value",
            "onExceedsUpperBoundValue",
            "on_exceeds_lower_bound",
            "onExceedsLowerBound",
            "on_exceeds_lower_bound_value",
            "onExceedsLowerBoundValue",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            LowerBound,
            LowerBoundValue,
            UpperBound,
            UpperBoundValue,
            OnExceedsUpperBound,
            OnExceedsUpperBoundValue,
            OnExceedsLowerBound,
            OnExceedsLowerBoundValue,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "lowerBound" | "lower_bound" => Ok(GeneratedField::LowerBound),
                            "lowerBoundValue" | "lower_bound_value" => Ok(GeneratedField::LowerBoundValue),
                            "upperBound" | "upper_bound" => Ok(GeneratedField::UpperBound),
                            "upperBoundValue" | "upper_bound_value" => Ok(GeneratedField::UpperBoundValue),
                            "onExceedsUpperBound" | "on_exceeds_upper_bound" => Ok(GeneratedField::OnExceedsUpperBound),
                            "onExceedsUpperBoundValue" | "on_exceeds_upper_bound_value" => Ok(GeneratedField::OnExceedsUpperBoundValue),
                            "onExceedsLowerBound" | "on_exceeds_lower_bound" => Ok(GeneratedField::OnExceedsLowerBound),
                            "onExceedsLowerBoundValue" | "on_exceeds_lower_bound_value" => Ok(GeneratedField::OnExceedsLowerBoundValue),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::BoundTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.BoundTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::BoundTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut lower_bound__ = None;
                let mut lower_bound_value__ = None;
                let mut upper_bound__ = None;
                let mut upper_bound_value__ = None;
                let mut on_exceeds_upper_bound__ = None;
                let mut on_exceeds_upper_bound_value__ = None;
                let mut on_exceeds_lower_bound__ = None;
                let mut on_exceeds_lower_bound_value__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::LowerBound => {
                            if lower_bound__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lowerBound"));
                            }
                            lower_bound__ = map_.next_value()?;
                        }
                        GeneratedField::LowerBoundValue => {
                            if lower_bound_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lowerBoundValue"));
                            }
                            lower_bound_value__ = map_.next_value()?;
                        }
                        GeneratedField::UpperBound => {
                            if upper_bound__.is_some() {
                                return Err(serde::de::Error::duplicate_field("upperBound"));
                            }
                            upper_bound__ = map_.next_value()?;
                        }
                        GeneratedField::UpperBoundValue => {
                            if upper_bound_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("upperBoundValue"));
                            }
                            upper_bound_value__ = map_.next_value()?;
                        }
                        GeneratedField::OnExceedsUpperBound => {
                            if on_exceeds_upper_bound__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onExceedsUpperBound"));
                            }
                            on_exceeds_upper_bound__ = map_.next_value()?;
                        }
                        GeneratedField::OnExceedsUpperBoundValue => {
                            if on_exceeds_upper_bound_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onExceedsUpperBoundValue"));
                            }
                            on_exceeds_upper_bound_value__ = map_.next_value()?;
                        }
                        GeneratedField::OnExceedsLowerBound => {
                            if on_exceeds_lower_bound__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onExceedsLowerBound"));
                            }
                            on_exceeds_lower_bound__ = map_.next_value()?;
                        }
                        GeneratedField::OnExceedsLowerBoundValue => {
                            if on_exceeds_lower_bound_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onExceedsLowerBoundValue"));
                            }
                            on_exceeds_lower_bound_value__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::BoundTask {
                    lower_bound: lower_bound__,
                    lower_bound_value: lower_bound_value__,
                    upper_bound: upper_bound__,
                    upper_bound_value: upper_bound_value__,
                    on_exceeds_upper_bound: on_exceeds_upper_bound__,
                    on_exceeds_upper_bound_value: on_exceeds_upper_bound_value__,
                    on_exceeds_lower_bound: on_exceeds_lower_bound__,
                    on_exceeds_lower_bound_value: on_exceeds_lower_bound_value__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.BoundTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::BufferLayoutParseTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.offset.is_some() {
            len += 1;
        }
        if self.endian.is_some() {
            len += 1;
        }
        if self.r#type.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.BufferLayoutParseTask", len)?;
        if let Some(v) = self.offset.as_ref() {
            struct_ser.serialize_field("offset", v)?;
        }
        if let Some(v) = self.endian.as_ref() {
            let v = oracle_job::buffer_layout_parse_task::Endian::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("endian", &v)?;
        }
        if let Some(v) = self.r#type.as_ref() {
            let v = oracle_job::buffer_layout_parse_task::BufferParseType::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("type", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::BufferLayoutParseTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "offset",
            "endian",
            "type",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Offset,
            Endian,
            Type,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "offset" => Ok(GeneratedField::Offset),
                            "endian" => Ok(GeneratedField::Endian),
                            "type" => Ok(GeneratedField::Type),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::BufferLayoutParseTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.BufferLayoutParseTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::BufferLayoutParseTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut offset__ = None;
                let mut endian__ = None;
                let mut r#type__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Offset => {
                            if offset__.is_some() {
                                return Err(serde::de::Error::duplicate_field("offset"));
                            }
                            offset__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Endian => {
                            if endian__.is_some() {
                                return Err(serde::de::Error::duplicate_field("endian"));
                            }
                            endian__ = map_.next_value::<::std::option::Option<oracle_job::buffer_layout_parse_task::Endian>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Type => {
                            if r#type__.is_some() {
                                return Err(serde::de::Error::duplicate_field("type"));
                            }
                            r#type__ = map_.next_value::<::std::option::Option<oracle_job::buffer_layout_parse_task::BufferParseType>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::BufferLayoutParseTask {
                    offset: offset__,
                    endian: endian__,
                    r#type: r#type__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.BufferLayoutParseTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::buffer_layout_parse_task::BufferParseType {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Pubkey => "pubkey",
            Self::Bool => "bool",
            Self::U8 => "u8",
            Self::I8 => "i8",
            Self::U16 => "u16",
            Self::I16 => "i16",
            Self::U32 => "u32",
            Self::I32 => "i32",
            Self::F32 => "f32",
            Self::U64 => "u64",
            Self::I64 => "i64",
            Self::F64 => "f64",
            Self::U128 => "u128",
            Self::I128 => "i128",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::buffer_layout_parse_task::BufferParseType {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pubkey",
            "bool",
            "u8",
            "i8",
            "u16",
            "i16",
            "u32",
            "i32",
            "f32",
            "u64",
            "i64",
            "f64",
            "u128",
            "i128",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::buffer_layout_parse_task::BufferParseType;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "pubkey" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::Pubkey),
                    "bool" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::Bool),
                    "u8" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::U8),
                    "i8" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::I8),
                    "u16" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::U16),
                    "i16" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::I16),
                    "u32" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::U32),
                    "i32" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::I32),
                    "f32" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::F32),
                    "u64" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::U64),
                    "i64" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::I64),
                    "f64" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::F64),
                    "u128" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::U128),
                    "i128" => Ok(oracle_job::buffer_layout_parse_task::BufferParseType::I128),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::buffer_layout_parse_task::Endian {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::LittleEndian => "LITTLE_ENDIAN",
            Self::BigEndian => "BIG_ENDIAN",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::buffer_layout_parse_task::Endian {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "LITTLE_ENDIAN",
            "BIG_ENDIAN",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::buffer_layout_parse_task::Endian;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "LITTLE_ENDIAN" => Ok(oracle_job::buffer_layout_parse_task::Endian::LittleEndian),
                    "BIG_ENDIAN" => Ok(oracle_job::buffer_layout_parse_task::Endian::BigEndian),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::CacheTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.cache_items.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.CacheTask", len)?;
        if !self.cache_items.is_empty() {
            struct_ser.serialize_field("cacheItems", &self.cache_items)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::CacheTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "cache_items",
            "cacheItems",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            CacheItems,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "cacheItems" | "cache_items" => Ok(GeneratedField::CacheItems),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::CacheTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.CacheTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::CacheTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut cache_items__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::CacheItems => {
                            if cache_items__.is_some() {
                                return Err(serde::de::Error::duplicate_field("cacheItems"));
                            }
                            cache_items__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::CacheTask {
                    cache_items: cache_items__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.CacheTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::cache_task::CacheItem {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.variable_name.is_some() {
            len += 1;
        }
        if self.job.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.CacheTask.CacheItem", len)?;
        if let Some(v) = self.variable_name.as_ref() {
            struct_ser.serialize_field("variableName", v)?;
        }
        if let Some(v) = self.job.as_ref() {
            struct_ser.serialize_field("job", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::cache_task::CacheItem {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "variable_name",
            "variableName",
            "job",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            VariableName,
            Job,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "variableName" | "variable_name" => Ok(GeneratedField::VariableName),
                            "job" => Ok(GeneratedField::Job),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::cache_task::CacheItem;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.CacheTask.CacheItem")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::cache_task::CacheItem, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut variable_name__ = None;
                let mut job__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::VariableName => {
                            if variable_name__.is_some() {
                                return Err(serde::de::Error::duplicate_field("variableName"));
                            }
                            variable_name__ = map_.next_value()?;
                        }
                        GeneratedField::Job => {
                            if job__.is_some() {
                                return Err(serde::de::Error::duplicate_field("job"));
                            }
                            job__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::cache_task::CacheItem {
                    variable_name: variable_name__,
                    job: job__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.CacheTask.CacheItem", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ComparisonTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.op.is_some() {
            len += 1;
        }
        if self.on_true.is_some() {
            len += 1;
        }
        if self.on_true_value.is_some() {
            len += 1;
        }
        if self.on_false.is_some() {
            len += 1;
        }
        if self.on_false_value.is_some() {
            len += 1;
        }
        if self.on_failure.is_some() {
            len += 1;
        }
        if self.on_failure_value.is_some() {
            len += 1;
        }
        if self.lhs.is_some() {
            len += 1;
        }
        if self.rhs.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.ComparisonTask", len)?;
        if let Some(v) = self.op.as_ref() {
            let v = oracle_job::comparison_task::Operation::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("op", &v)?;
        }
        if let Some(v) = self.on_true.as_ref() {
            struct_ser.serialize_field("onTrue", v)?;
        }
        if let Some(v) = self.on_true_value.as_ref() {
            struct_ser.serialize_field("onTrueValue", v)?;
        }
        if let Some(v) = self.on_false.as_ref() {
            struct_ser.serialize_field("onFalse", v)?;
        }
        if let Some(v) = self.on_false_value.as_ref() {
            struct_ser.serialize_field("onFalseValue", v)?;
        }
        if let Some(v) = self.on_failure.as_ref() {
            struct_ser.serialize_field("onFailure", v)?;
        }
        if let Some(v) = self.on_failure_value.as_ref() {
            struct_ser.serialize_field("onFailureValue", v)?;
        }
        if let Some(v) = self.lhs.as_ref() {
            match v {
                oracle_job::comparison_task::Lhs::Lhs(v) => {
                    struct_ser.serialize_field("lhs", v)?;
                }
                oracle_job::comparison_task::Lhs::LhsValue(v) => {
                    struct_ser.serialize_field("lhsValue", v)?;
                }
            }
        }
        if let Some(v) = self.rhs.as_ref() {
            match v {
                oracle_job::comparison_task::Rhs::Rhs(v) => {
                    struct_ser.serialize_field("rhs", v)?;
                }
                oracle_job::comparison_task::Rhs::RhsValue(v) => {
                    struct_ser.serialize_field("rhsValue", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ComparisonTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "op",
            "on_true",
            "onTrue",
            "on_true_value",
            "onTrueValue",
            "on_false",
            "onFalse",
            "on_false_value",
            "onFalseValue",
            "on_failure",
            "onFailure",
            "on_failure_value",
            "onFailureValue",
            "lhs",
            "lhs_value",
            "lhsValue",
            "rhs",
            "rhs_value",
            "rhsValue",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Op,
            OnTrue,
            OnTrueValue,
            OnFalse,
            OnFalseValue,
            OnFailure,
            OnFailureValue,
            Lhs,
            LhsValue,
            Rhs,
            RhsValue,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "op" => Ok(GeneratedField::Op),
                            "onTrue" | "on_true" => Ok(GeneratedField::OnTrue),
                            "onTrueValue" | "on_true_value" => Ok(GeneratedField::OnTrueValue),
                            "onFalse" | "on_false" => Ok(GeneratedField::OnFalse),
                            "onFalseValue" | "on_false_value" => Ok(GeneratedField::OnFalseValue),
                            "onFailure" | "on_failure" => Ok(GeneratedField::OnFailure),
                            "onFailureValue" | "on_failure_value" => Ok(GeneratedField::OnFailureValue),
                            "lhs" => Ok(GeneratedField::Lhs),
                            "lhsValue" | "lhs_value" => Ok(GeneratedField::LhsValue),
                            "rhs" => Ok(GeneratedField::Rhs),
                            "rhsValue" | "rhs_value" => Ok(GeneratedField::RhsValue),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ComparisonTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.ComparisonTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::ComparisonTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut op__ = None;
                let mut on_true__ = None;
                let mut on_true_value__ = None;
                let mut on_false__ = None;
                let mut on_false_value__ = None;
                let mut on_failure__ = None;
                let mut on_failure_value__ = None;
                let mut lhs__ = None;
                let mut rhs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Op => {
                            if op__.is_some() {
                                return Err(serde::de::Error::duplicate_field("op"));
                            }
                            op__ = map_.next_value::<::std::option::Option<oracle_job::comparison_task::Operation>>()?.map(|x| x as i32);
                        }
                        GeneratedField::OnTrue => {
                            if on_true__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onTrue"));
                            }
                            on_true__ = map_.next_value()?;
                        }
                        GeneratedField::OnTrueValue => {
                            if on_true_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onTrueValue"));
                            }
                            on_true_value__ = map_.next_value()?;
                        }
                        GeneratedField::OnFalse => {
                            if on_false__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onFalse"));
                            }
                            on_false__ = map_.next_value()?;
                        }
                        GeneratedField::OnFalseValue => {
                            if on_false_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onFalseValue"));
                            }
                            on_false_value__ = map_.next_value()?;
                        }
                        GeneratedField::OnFailure => {
                            if on_failure__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onFailure"));
                            }
                            on_failure__ = map_.next_value()?;
                        }
                        GeneratedField::OnFailureValue => {
                            if on_failure_value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onFailureValue"));
                            }
                            on_failure_value__ = map_.next_value()?;
                        }
                        GeneratedField::Lhs => {
                            if lhs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lhs"));
                            }
                            lhs__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::comparison_task::Lhs::Lhs)
;
                        }
                        GeneratedField::LhsValue => {
                            if lhs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lhsValue"));
                            }
                            lhs__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::comparison_task::Lhs::LhsValue);
                        }
                        GeneratedField::Rhs => {
                            if rhs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("rhs"));
                            }
                            rhs__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::comparison_task::Rhs::Rhs)
;
                        }
                        GeneratedField::RhsValue => {
                            if rhs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("rhsValue"));
                            }
                            rhs__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::comparison_task::Rhs::RhsValue);
                        }
                    }
                }
                Ok(oracle_job::ComparisonTask {
                    op: op__,
                    on_true: on_true__,
                    on_true_value: on_true_value__,
                    on_false: on_false__,
                    on_false_value: on_false_value__,
                    on_failure: on_failure__,
                    on_failure_value: on_failure_value__,
                    lhs: lhs__,
                    rhs: rhs__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.ComparisonTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::comparison_task::Operation {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Eq => "OPERATION_EQ",
            Self::Gt => "OPERATION_GT",
            Self::Lt => "OPERATION_LT",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::comparison_task::Operation {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "OPERATION_EQ",
            "OPERATION_GT",
            "OPERATION_LT",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::comparison_task::Operation;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "OPERATION_EQ" => Ok(oracle_job::comparison_task::Operation::Eq),
                    "OPERATION_GT" => Ok(oracle_job::comparison_task::Operation::Gt),
                    "OPERATION_LT" => Ok(oracle_job::comparison_task::Operation::Lt),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ConditionalTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.attempt.is_empty() {
            len += 1;
        }
        if !self.on_failure.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.ConditionalTask", len)?;
        if !self.attempt.is_empty() {
            struct_ser.serialize_field("attempt", &self.attempt)?;
        }
        if !self.on_failure.is_empty() {
            struct_ser.serialize_field("onFailure", &self.on_failure)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ConditionalTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "attempt",
            "on_failure",
            "onFailure",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Attempt,
            OnFailure,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "attempt" => Ok(GeneratedField::Attempt),
                            "onFailure" | "on_failure" => Ok(GeneratedField::OnFailure),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ConditionalTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.ConditionalTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::ConditionalTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut attempt__ = None;
                let mut on_failure__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Attempt => {
                            if attempt__.is_some() {
                                return Err(serde::de::Error::duplicate_field("attempt"));
                            }
                            attempt__ = Some(map_.next_value()?);
                        }
                        GeneratedField::OnFailure => {
                            if on_failure__.is_some() {
                                return Err(serde::de::Error::duplicate_field("onFailure"));
                            }
                            on_failure__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::ConditionalTask {
                    attempt: attempt__.unwrap_or_default(),
                    on_failure: on_failure__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.ConditionalTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::CorexTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token.is_some() {
            len += 1;
        }
        if self.out_token.is_some() {
            len += 1;
        }
        if self.slippage.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.CorexTask", len)?;
        if let Some(v) = self.in_token.as_ref() {
            struct_ser.serialize_field("inToken", v)?;
        }
        if let Some(v) = self.out_token.as_ref() {
            struct_ser.serialize_field("outToken", v)?;
        }
        if let Some(v) = self.slippage.as_ref() {
            struct_ser.serialize_field("slippage", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::CorexTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token",
            "inToken",
            "out_token",
            "outToken",
            "slippage",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InToken,
            OutToken,
            Slippage,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inToken" | "in_token" => Ok(GeneratedField::InToken),
                            "outToken" | "out_token" => Ok(GeneratedField::OutToken),
                            "slippage" => Ok(GeneratedField::Slippage),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::CorexTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.CorexTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::CorexTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token__ = None;
                let mut out_token__ = None;
                let mut slippage__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InToken => {
                            if in_token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inToken"));
                            }
                            in_token__ = map_.next_value()?;
                        }
                        GeneratedField::OutToken => {
                            if out_token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outToken"));
                            }
                            out_token__ = map_.next_value()?;
                        }
                        GeneratedField::Slippage => {
                            if slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("slippage"));
                            }
                            slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::CorexTask {
                    in_token: in_token__,
                    out_token: out_token__,
                    slippage: slippage__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.CorexTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::CronParseTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.cron_pattern.is_some() {
            len += 1;
        }
        if self.clock_offset.is_some() {
            len += 1;
        }
        if self.clock.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.CronParseTask", len)?;
        if let Some(v) = self.cron_pattern.as_ref() {
            struct_ser.serialize_field("cronPattern", v)?;
        }
        if let Some(v) = self.clock_offset.as_ref() {
            struct_ser.serialize_field("clockOffset", v)?;
        }
        if let Some(v) = self.clock.as_ref() {
            let v = oracle_job::cron_parse_task::ClockType::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("clock", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::CronParseTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "cron_pattern",
            "cronPattern",
            "clock_offset",
            "clockOffset",
            "clock",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            CronPattern,
            ClockOffset,
            Clock,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "cronPattern" | "cron_pattern" => Ok(GeneratedField::CronPattern),
                            "clockOffset" | "clock_offset" => Ok(GeneratedField::ClockOffset),
                            "clock" => Ok(GeneratedField::Clock),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::CronParseTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.CronParseTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::CronParseTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut cron_pattern__ = None;
                let mut clock_offset__ = None;
                let mut clock__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::CronPattern => {
                            if cron_pattern__.is_some() {
                                return Err(serde::de::Error::duplicate_field("cronPattern"));
                            }
                            cron_pattern__ = map_.next_value()?;
                        }
                        GeneratedField::ClockOffset => {
                            if clock_offset__.is_some() {
                                return Err(serde::de::Error::duplicate_field("clockOffset"));
                            }
                            clock_offset__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Clock => {
                            if clock__.is_some() {
                                return Err(serde::de::Error::duplicate_field("clock"));
                            }
                            clock__ = map_.next_value::<::std::option::Option<oracle_job::cron_parse_task::ClockType>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::CronParseTask {
                    cron_pattern: cron_pattern__,
                    clock_offset: clock_offset__,
                    clock: clock__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.CronParseTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::cron_parse_task::ClockType {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Oracle => "ORACLE",
            Self::Sysclock => "SYSCLOCK",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::cron_parse_task::ClockType {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "ORACLE",
            "SYSCLOCK",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::cron_parse_task::ClockType;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "ORACLE" => Ok(oracle_job::cron_parse_task::ClockType::Oracle),
                    "SYSCLOCK" => Ok(oracle_job::cron_parse_task::ClockType::Sysclock),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::CurveFinanceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.chain.is_some() {
            len += 1;
        }
        if self.provider.is_some() {
            len += 1;
        }
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.out_decimals.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.CurveFinanceTask", len)?;
        if let Some(v) = self.chain.as_ref() {
            let v = oracle_job::curve_finance_task::Chain::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("chain", &v)?;
        }
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.out_decimals.as_ref() {
            struct_ser.serialize_field("outDecimals", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::CurveFinanceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "chain",
            "provider",
            "pool_address",
            "poolAddress",
            "out_decimals",
            "outDecimals",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Chain,
            Provider,
            PoolAddress,
            OutDecimals,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "chain" => Ok(GeneratedField::Chain),
                            "provider" => Ok(GeneratedField::Provider),
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "outDecimals" | "out_decimals" => Ok(GeneratedField::OutDecimals),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::CurveFinanceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.CurveFinanceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::CurveFinanceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut chain__ = None;
                let mut provider__ = None;
                let mut pool_address__ = None;
                let mut out_decimals__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Chain => {
                            if chain__.is_some() {
                                return Err(serde::de::Error::duplicate_field("chain"));
                            }
                            chain__ = map_.next_value::<::std::option::Option<oracle_job::curve_finance_task::Chain>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutDecimals => {
                            if out_decimals__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outDecimals"));
                            }
                            out_decimals__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::CurveFinanceTask {
                    chain: chain__,
                    provider: provider__,
                    pool_address: pool_address__,
                    out_decimals: out_decimals__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.CurveFinanceTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::curve_finance_task::Chain {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Ethereum => "CHAIN_ETHEREUM",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::curve_finance_task::Chain {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "CHAIN_ETHEREUM",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::curve_finance_task::Chain;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "CHAIN_ETHEREUM" => Ok(oracle_job::curve_finance_task::Chain::Ethereum),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::DivideTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.denominator.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.DivideTask", len)?;
        if let Some(v) = self.denominator.as_ref() {
            match v {
                oracle_job::divide_task::Denominator::Scalar(v) => {
                    struct_ser.serialize_field("scalar", v)?;
                }
                oracle_job::divide_task::Denominator::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::divide_task::Denominator::Job(v) => {
                    struct_ser.serialize_field("job", v)?;
                }
                oracle_job::divide_task::Denominator::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::DivideTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "scalar",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "job",
            "big",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Scalar,
            AggregatorPubkey,
            Job,
            Big,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "scalar" => Ok(GeneratedField::Scalar),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "job" => Ok(GeneratedField::Job),
                            "big" => Ok(GeneratedField::Big),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::DivideTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.DivideTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::DivideTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut denominator__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Scalar => {
                            if denominator__.is_some() {
                                return Err(serde::de::Error::duplicate_field("scalar"));
                            }
                            denominator__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::divide_task::Denominator::Scalar(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if denominator__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            denominator__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::divide_task::Denominator::AggregatorPubkey);
                        }
                        GeneratedField::Job => {
                            if denominator__.is_some() {
                                return Err(serde::de::Error::duplicate_field("job"));
                            }
                            denominator__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::divide_task::Denominator::Job)
;
                        }
                        GeneratedField::Big => {
                            if denominator__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            denominator__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::divide_task::Denominator::Big);
                        }
                    }
                }
                Ok(oracle_job::DivideTask {
                    denominator: denominator__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.DivideTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::EtherfuseTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.token.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.EtherfuseTask", len)?;
        if let Some(v) = self.token.as_ref() {
            let v = oracle_job::etherfuse_task::Token::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("token", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::EtherfuseTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "token",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Token,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "token" => Ok(GeneratedField::Token),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::EtherfuseTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.EtherfuseTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::EtherfuseTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut token__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Token => {
                            if token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("token"));
                            }
                            token__ = map_.next_value::<::std::option::Option<oracle_job::etherfuse_task::Token>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::EtherfuseTask {
                    token: token__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.EtherfuseTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::etherfuse_task::Token {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Cetes => "TOKEN_CETES",
            Self::Ustry => "TOKEN_USTRY",
            Self::Eurob => "TOKEN_EUROB",
            Self::Tesouro => "TOKEN_TESOURO",
            Self::Gilts => "TOKEN_GILTS",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::etherfuse_task::Token {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "TOKEN_CETES",
            "TOKEN_USTRY",
            "TOKEN_EUROB",
            "TOKEN_TESOURO",
            "TOKEN_GILTS",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::etherfuse_task::Token;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "TOKEN_CETES" => Ok(oracle_job::etherfuse_task::Token::Cetes),
                    "TOKEN_USTRY" => Ok(oracle_job::etherfuse_task::Token::Ustry),
                    "TOKEN_EUROB" => Ok(oracle_job::etherfuse_task::Token::Eurob),
                    "TOKEN_TESOURO" => Ok(oracle_job::etherfuse_task::Token::Tesouro),
                    "TOKEN_GILTS" => Ok(oracle_job::etherfuse_task::Token::Gilts),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::EwmaTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.aggregator_address.is_some() {
            len += 1;
        }
        if self.period.is_some() {
            len += 1;
        }
        if self.lambda.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.EwmaTask", len)?;
        if let Some(v) = self.aggregator_address.as_ref() {
            struct_ser.serialize_field("aggregatorAddress", v)?;
        }
        if let Some(v) = self.period.as_ref() {
            struct_ser.serialize_field("period", v)?;
        }
        if let Some(v) = self.lambda.as_ref() {
            struct_ser.serialize_field("lambda", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::EwmaTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "aggregator_address",
            "aggregatorAddress",
            "period",
            "lambda",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            AggregatorAddress,
            Period,
            Lambda,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "aggregatorAddress" | "aggregator_address" => Ok(GeneratedField::AggregatorAddress),
                            "period" => Ok(GeneratedField::Period),
                            "lambda" => Ok(GeneratedField::Lambda),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::EwmaTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.EwmaTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::EwmaTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut aggregator_address__ = None;
                let mut period__ = None;
                let mut lambda__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::AggregatorAddress => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorAddress"));
                            }
                            aggregator_address__ = map_.next_value()?;
                        }
                        GeneratedField::Period => {
                            if period__.is_some() {
                                return Err(serde::de::Error::duplicate_field("period"));
                            }
                            period__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Lambda => {
                            if lambda__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lambda"));
                            }
                            lambda__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::EwmaTask {
                    aggregator_address: aggregator_address__,
                    period: period__,
                    lambda: lambda__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.EwmaTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ExponentPtLinearPricingTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.vault.is_some() {
            len += 1;
        }
        if self.start_price.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.ExponentPTLinearPricingTask", len)?;
        if let Some(v) = self.vault.as_ref() {
            struct_ser.serialize_field("vault", v)?;
        }
        if let Some(v) = self.start_price.as_ref() {
            struct_ser.serialize_field("startPrice", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ExponentPtLinearPricingTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "vault",
            "start_price",
            "startPrice",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Vault,
            StartPrice,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "vault" => Ok(GeneratedField::Vault),
                            "startPrice" | "start_price" => Ok(GeneratedField::StartPrice),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ExponentPtLinearPricingTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.ExponentPTLinearPricingTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::ExponentPtLinearPricingTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut vault__ = None;
                let mut start_price__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Vault => {
                            if vault__.is_some() {
                                return Err(serde::de::Error::duplicate_field("vault"));
                            }
                            vault__ = map_.next_value()?;
                        }
                        GeneratedField::StartPrice => {
                            if start_price__.is_some() {
                                return Err(serde::de::Error::duplicate_field("startPrice"));
                            }
                            start_price__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::ExponentPtLinearPricingTask {
                    vault: vault__,
                    start_price: start_price__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.ExponentPTLinearPricingTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ExponentTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.vault.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.ExponentTask", len)?;
        if let Some(v) = self.vault.as_ref() {
            struct_ser.serialize_field("vault", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ExponentTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "vault",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Vault,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "vault" => Ok(GeneratedField::Vault),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ExponentTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.ExponentTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::ExponentTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut vault__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Vault => {
                            if vault__.is_some() {
                                return Err(serde::de::Error::duplicate_field("vault"));
                            }
                            vault__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::ExponentTask {
                    vault: vault__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.ExponentTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::FragmetricTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.token.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.FragmetricTask", len)?;
        if let Some(v) = self.token.as_ref() {
            let v = oracle_job::fragmetric_task::Token::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("token", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::FragmetricTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "token",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Token,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "token" => Ok(GeneratedField::Token),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::FragmetricTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.FragmetricTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::FragmetricTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut token__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Token => {
                            if token__.is_some() {
                                return Err(serde::de::Error::duplicate_field("token"));
                            }
                            token__ = map_.next_value::<::std::option::Option<oracle_job::fragmetric_task::Token>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::FragmetricTask {
                    token: token__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.FragmetricTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::fragmetric_task::Token {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::FragSol => "TOKEN_FRAG_SOL",
            Self::NSol => "TOKEN_N_SOL",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::fragmetric_task::Token {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "TOKEN_FRAG_SOL",
            "TOKEN_N_SOL",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::fragmetric_task::Token;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "TOKEN_FRAG_SOL" => Ok(oracle_job::fragmetric_task::Token::FragSol),
                    "TOKEN_N_SOL" => Ok(oracle_job::fragmetric_task::Token::NSol),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::GlyphTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.zero_for_one.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.GlyphTask", len)?;
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.zero_for_one.as_ref() {
            struct_ser.serialize_field("zeroForOne", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::GlyphTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pool_address",
            "poolAddress",
            "zero_for_one",
            "zeroForOne",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PoolAddress,
            ZeroForOne,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "zeroForOne" | "zero_for_one" => Ok(GeneratedField::ZeroForOne),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::GlyphTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.GlyphTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::GlyphTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pool_address__ = None;
                let mut zero_for_one__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::ZeroForOne => {
                            if zero_for_one__.is_some() {
                                return Err(serde::de::Error::duplicate_field("zeroForOne"));
                            }
                            zero_for_one__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::GlyphTask {
                    pool_address: pool_address__,
                    zero_for_one: zero_for_one__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.GlyphTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::HistoryFunctionTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.method.is_some() {
            len += 1;
        }
        if self.aggregator_address.is_some() {
            len += 1;
        }
        if self.period.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.HistoryFunctionTask", len)?;
        if let Some(v) = self.method.as_ref() {
            let v = oracle_job::history_function_task::Method::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("method", &v)?;
        }
        if let Some(v) = self.aggregator_address.as_ref() {
            struct_ser.serialize_field("aggregatorAddress", v)?;
        }
        if let Some(v) = self.period.as_ref() {
            struct_ser.serialize_field("period", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::HistoryFunctionTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "method",
            "aggregator_address",
            "aggregatorAddress",
            "period",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Method,
            AggregatorAddress,
            Period,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "method" => Ok(GeneratedField::Method),
                            "aggregatorAddress" | "aggregator_address" => Ok(GeneratedField::AggregatorAddress),
                            "period" => Ok(GeneratedField::Period),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::HistoryFunctionTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.HistoryFunctionTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::HistoryFunctionTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut method__ = None;
                let mut aggregator_address__ = None;
                let mut period__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Method => {
                            if method__.is_some() {
                                return Err(serde::de::Error::duplicate_field("method"));
                            }
                            method__ = map_.next_value::<::std::option::Option<oracle_job::history_function_task::Method>>()?.map(|x| x as i32);
                        }
                        GeneratedField::AggregatorAddress => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorAddress"));
                            }
                            aggregator_address__ = map_.next_value()?;
                        }
                        GeneratedField::Period => {
                            if period__.is_some() {
                                return Err(serde::de::Error::duplicate_field("period"));
                            }
                            period__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::HistoryFunctionTask {
                    method: method__,
                    aggregator_address: aggregator_address__,
                    period: period__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.HistoryFunctionTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::history_function_task::Method {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Min => "METHOD_MIN",
            Self::Max => "METHOD_MAX",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::history_function_task::Method {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "METHOD_MIN",
            "METHOD_MAX",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::history_function_task::Method;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "METHOD_MIN" => Ok(oracle_job::history_function_task::Method::Min),
                    "METHOD_MAX" => Ok(oracle_job::history_function_task::Method::Max),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::HttpTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.url.is_some() {
            len += 1;
        }
        if self.method.is_some() {
            len += 1;
        }
        if !self.headers.is_empty() {
            len += 1;
        }
        if self.body.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.HttpTask", len)?;
        if let Some(v) = self.url.as_ref() {
            struct_ser.serialize_field("url", v)?;
        }
        if let Some(v) = self.method.as_ref() {
            let v = oracle_job::http_task::Method::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("method", &v)?;
        }
        if !self.headers.is_empty() {
            struct_ser.serialize_field("headers", &self.headers)?;
        }
        if let Some(v) = self.body.as_ref() {
            struct_ser.serialize_field("body", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::HttpTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "url",
            "method",
            "headers",
            "body",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Url,
            Method,
            Headers,
            Body,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "url" => Ok(GeneratedField::Url),
                            "method" => Ok(GeneratedField::Method),
                            "headers" => Ok(GeneratedField::Headers),
                            "body" => Ok(GeneratedField::Body),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::HttpTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.HttpTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::HttpTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut url__ = None;
                let mut method__ = None;
                let mut headers__ = None;
                let mut body__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Url => {
                            if url__.is_some() {
                                return Err(serde::de::Error::duplicate_field("url"));
                            }
                            url__ = map_.next_value()?;
                        }
                        GeneratedField::Method => {
                            if method__.is_some() {
                                return Err(serde::de::Error::duplicate_field("method"));
                            }
                            method__ = map_.next_value::<::std::option::Option<oracle_job::http_task::Method>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Headers => {
                            if headers__.is_some() {
                                return Err(serde::de::Error::duplicate_field("headers"));
                            }
                            headers__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Body => {
                            if body__.is_some() {
                                return Err(serde::de::Error::duplicate_field("body"));
                            }
                            body__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::HttpTask {
                    url: url__,
                    method: method__,
                    headers: headers__.unwrap_or_default(),
                    body: body__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.HttpTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::http_task::Header {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.key.is_some() {
            len += 1;
        }
        if self.value.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.HttpTask.Header", len)?;
        if let Some(v) = self.key.as_ref() {
            struct_ser.serialize_field("key", v)?;
        }
        if let Some(v) = self.value.as_ref() {
            struct_ser.serialize_field("value", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::http_task::Header {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "key",
            "value",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Key,
            Value,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "key" => Ok(GeneratedField::Key),
                            "value" => Ok(GeneratedField::Value),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::http_task::Header;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.HttpTask.Header")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::http_task::Header, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut key__ = None;
                let mut value__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Key => {
                            if key__.is_some() {
                                return Err(serde::de::Error::duplicate_field("key"));
                            }
                            key__ = map_.next_value()?;
                        }
                        GeneratedField::Value => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("value"));
                            }
                            value__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::http_task::Header {
                    key: key__,
                    value: value__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.HttpTask.Header", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::http_task::Method {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Unkown => "METHOD_UNKOWN",
            Self::Get => "METHOD_GET",
            Self::Post => "METHOD_POST",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::http_task::Method {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "METHOD_UNKOWN",
            "METHOD_GET",
            "METHOD_POST",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::http_task::Method;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "METHOD_UNKOWN" => Ok(oracle_job::http_task::Method::Unkown),
                    "METHOD_GET" => Ok(oracle_job::http_task::Method::Get),
                    "METHOD_POST" => Ok(oracle_job::http_task::Method::Post),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::JsonParseTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.path.is_some() {
            len += 1;
        }
        if self.aggregation_method.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.JsonParseTask", len)?;
        if let Some(v) = self.path.as_ref() {
            struct_ser.serialize_field("path", v)?;
        }
        if let Some(v) = self.aggregation_method.as_ref() {
            let v = oracle_job::json_parse_task::AggregationMethod::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("aggregationMethod", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::JsonParseTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "path",
            "aggregation_method",
            "aggregationMethod",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Path,
            AggregationMethod,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "path" => Ok(GeneratedField::Path),
                            "aggregationMethod" | "aggregation_method" => Ok(GeneratedField::AggregationMethod),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::JsonParseTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.JsonParseTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::JsonParseTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut path__ = None;
                let mut aggregation_method__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Path => {
                            if path__.is_some() {
                                return Err(serde::de::Error::duplicate_field("path"));
                            }
                            path__ = map_.next_value()?;
                        }
                        GeneratedField::AggregationMethod => {
                            if aggregation_method__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregationMethod"));
                            }
                            aggregation_method__ = map_.next_value::<::std::option::Option<oracle_job::json_parse_task::AggregationMethod>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::JsonParseTask {
                    path: path__,
                    aggregation_method: aggregation_method__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.JsonParseTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::json_parse_task::AggregationMethod {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::None => "NONE",
            Self::Min => "MIN",
            Self::Max => "MAX",
            Self::Sum => "SUM",
            Self::Mean => "MEAN",
            Self::Median => "MEDIAN",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::json_parse_task::AggregationMethod {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "NONE",
            "MIN",
            "MAX",
            "SUM",
            "MEAN",
            "MEDIAN",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::json_parse_task::AggregationMethod;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "NONE" => Ok(oracle_job::json_parse_task::AggregationMethod::None),
                    "MIN" => Ok(oracle_job::json_parse_task::AggregationMethod::Min),
                    "MAX" => Ok(oracle_job::json_parse_task::AggregationMethod::Max),
                    "SUM" => Ok(oracle_job::json_parse_task::AggregationMethod::Sum),
                    "MEAN" => Ok(oracle_job::json_parse_task::AggregationMethod::Mean),
                    "MEDIAN" => Ok(oracle_job::json_parse_task::AggregationMethod::Median),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::JupiterSwapTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token_address.is_some() {
            len += 1;
        }
        if self.out_token_address.is_some() {
            len += 1;
        }
        if self.slippage.is_some() {
            len += 1;
        }
        if self.version.is_some() {
            len += 1;
        }
        if self.routes_filters.is_some() {
            len += 1;
        }
        if self.swap_amount.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.JupiterSwapTask", len)?;
        if let Some(v) = self.in_token_address.as_ref() {
            struct_ser.serialize_field("inTokenAddress", v)?;
        }
        if let Some(v) = self.out_token_address.as_ref() {
            struct_ser.serialize_field("outTokenAddress", v)?;
        }
        if let Some(v) = self.slippage.as_ref() {
            struct_ser.serialize_field("slippage", v)?;
        }
        if let Some(v) = self.version.as_ref() {
            let v = oracle_job::jupiter_swap_task::Version::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("version", &v)?;
        }
        if let Some(v) = self.routes_filters.as_ref() {
            match v {
                oracle_job::jupiter_swap_task::RoutesFilters::AllowList(v) => {
                    struct_ser.serialize_field("allowList", v)?;
                }
                oracle_job::jupiter_swap_task::RoutesFilters::DenyList(v) => {
                    struct_ser.serialize_field("denyList", v)?;
                }
            }
        }
        if let Some(v) = self.swap_amount.as_ref() {
            match v {
                oracle_job::jupiter_swap_task::SwapAmount::BaseAmount(v) => {
                    struct_ser.serialize_field("baseAmount", v)?;
                }
                oracle_job::jupiter_swap_task::SwapAmount::QuoteAmount(v) => {
                    struct_ser.serialize_field("quoteAmount", v)?;
                }
                oracle_job::jupiter_swap_task::SwapAmount::BaseAmountString(v) => {
                    struct_ser.serialize_field("baseAmountString", v)?;
                }
                oracle_job::jupiter_swap_task::SwapAmount::QuoteAmountString(v) => {
                    struct_ser.serialize_field("quoteAmountString", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::JupiterSwapTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token_address",
            "inTokenAddress",
            "out_token_address",
            "outTokenAddress",
            "slippage",
            "version",
            "allow_list",
            "allowList",
            "deny_list",
            "denyList",
            "base_amount",
            "baseAmount",
            "quote_amount",
            "quoteAmount",
            "base_amount_string",
            "baseAmountString",
            "quote_amount_string",
            "quoteAmountString",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InTokenAddress,
            OutTokenAddress,
            Slippage,
            Version,
            AllowList,
            DenyList,
            BaseAmount,
            QuoteAmount,
            BaseAmountString,
            QuoteAmountString,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inTokenAddress" | "in_token_address" => Ok(GeneratedField::InTokenAddress),
                            "outTokenAddress" | "out_token_address" => Ok(GeneratedField::OutTokenAddress),
                            "slippage" => Ok(GeneratedField::Slippage),
                            "version" => Ok(GeneratedField::Version),
                            "allowList" | "allow_list" => Ok(GeneratedField::AllowList),
                            "denyList" | "deny_list" => Ok(GeneratedField::DenyList),
                            "baseAmount" | "base_amount" => Ok(GeneratedField::BaseAmount),
                            "quoteAmount" | "quote_amount" => Ok(GeneratedField::QuoteAmount),
                            "baseAmountString" | "base_amount_string" => Ok(GeneratedField::BaseAmountString),
                            "quoteAmountString" | "quote_amount_string" => Ok(GeneratedField::QuoteAmountString),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::JupiterSwapTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.JupiterSwapTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::JupiterSwapTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token_address__ = None;
                let mut out_token_address__ = None;
                let mut slippage__ = None;
                let mut version__ = None;
                let mut routes_filters__ = None;
                let mut swap_amount__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InTokenAddress => {
                            if in_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAddress"));
                            }
                            in_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutTokenAddress => {
                            if out_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outTokenAddress"));
                            }
                            out_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::Slippage => {
                            if slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("slippage"));
                            }
                            slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Version => {
                            if version__.is_some() {
                                return Err(serde::de::Error::duplicate_field("version"));
                            }
                            version__ = map_.next_value::<::std::option::Option<oracle_job::jupiter_swap_task::Version>>()?.map(|x| x as i32);
                        }
                        GeneratedField::AllowList => {
                            if routes_filters__.is_some() {
                                return Err(serde::de::Error::duplicate_field("allowList"));
                            }
                            routes_filters__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::jupiter_swap_task::RoutesFilters::AllowList)
;
                        }
                        GeneratedField::DenyList => {
                            if routes_filters__.is_some() {
                                return Err(serde::de::Error::duplicate_field("denyList"));
                            }
                            routes_filters__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::jupiter_swap_task::RoutesFilters::DenyList)
;
                        }
                        GeneratedField::BaseAmount => {
                            if swap_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("baseAmount"));
                            }
                            swap_amount__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::jupiter_swap_task::SwapAmount::BaseAmount(x.0));
                        }
                        GeneratedField::QuoteAmount => {
                            if swap_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("quoteAmount"));
                            }
                            swap_amount__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::jupiter_swap_task::SwapAmount::QuoteAmount(x.0));
                        }
                        GeneratedField::BaseAmountString => {
                            if swap_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("baseAmountString"));
                            }
                            swap_amount__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::jupiter_swap_task::SwapAmount::BaseAmountString);
                        }
                        GeneratedField::QuoteAmountString => {
                            if swap_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("quoteAmountString"));
                            }
                            swap_amount__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::jupiter_swap_task::SwapAmount::QuoteAmountString);
                        }
                    }
                }
                Ok(oracle_job::JupiterSwapTask {
                    in_token_address: in_token_address__,
                    out_token_address: out_token_address__,
                    slippage: slippage__,
                    version: version__,
                    routes_filters: routes_filters__,
                    swap_amount: swap_amount__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.JupiterSwapTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::jupiter_swap_task::FilterList {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.labels.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.JupiterSwapTask.FilterList", len)?;
        if !self.labels.is_empty() {
            struct_ser.serialize_field("labels", &self.labels)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::jupiter_swap_task::FilterList {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "labels",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Labels,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "labels" => Ok(GeneratedField::Labels),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::jupiter_swap_task::FilterList;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.JupiterSwapTask.FilterList")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::jupiter_swap_task::FilterList, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut labels__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Labels => {
                            if labels__.is_some() {
                                return Err(serde::de::Error::duplicate_field("labels"));
                            }
                            labels__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::jupiter_swap_task::FilterList {
                    labels: labels__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.JupiterSwapTask.FilterList", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::jupiter_swap_task::Version {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::V1 => "VERSION_V1",
            Self::V2 => "VERSION_V2",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::jupiter_swap_task::Version {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "VERSION_V1",
            "VERSION_V2",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::jupiter_swap_task::Version;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "VERSION_V1" => Ok(oracle_job::jupiter_swap_task::Version::V1),
                    "VERSION_V2" => Ok(oracle_job::jupiter_swap_task::Version::V2),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::LendingRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.protocol.is_some() {
            len += 1;
        }
        if self.asset_mint.is_some() {
            len += 1;
        }
        if self.field.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LendingRateTask", len)?;
        if let Some(v) = self.protocol.as_ref() {
            struct_ser.serialize_field("protocol", v)?;
        }
        if let Some(v) = self.asset_mint.as_ref() {
            struct_ser.serialize_field("assetMint", v)?;
        }
        if let Some(v) = self.field.as_ref() {
            let v = oracle_job::lending_rate_task::Field::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("field", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::LendingRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "protocol",
            "asset_mint",
            "assetMint",
            "field",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Protocol,
            AssetMint,
            Field,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "protocol" => Ok(GeneratedField::Protocol),
                            "assetMint" | "asset_mint" => Ok(GeneratedField::AssetMint),
                            "field" => Ok(GeneratedField::Field),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::LendingRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LendingRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::LendingRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut protocol__ = None;
                let mut asset_mint__ = None;
                let mut field__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Protocol => {
                            if protocol__.is_some() {
                                return Err(serde::de::Error::duplicate_field("protocol"));
                            }
                            protocol__ = map_.next_value()?;
                        }
                        GeneratedField::AssetMint => {
                            if asset_mint__.is_some() {
                                return Err(serde::de::Error::duplicate_field("assetMint"));
                            }
                            asset_mint__ = map_.next_value()?;
                        }
                        GeneratedField::Field => {
                            if field__.is_some() {
                                return Err(serde::de::Error::duplicate_field("field"));
                            }
                            field__ = map_.next_value::<::std::option::Option<oracle_job::lending_rate_task::Field>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::LendingRateTask {
                    protocol: protocol__,
                    asset_mint: asset_mint__,
                    field: field__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LendingRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::lending_rate_task::Field {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::DepositRate => "FIELD_DEPOSIT_RATE",
            Self::BorrowRate => "FIELD_BORROW_RATE",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::lending_rate_task::Field {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "FIELD_DEPOSIT_RATE",
            "FIELD_BORROW_RATE",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::lending_rate_task::Field;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "FIELD_DEPOSIT_RATE" => Ok(oracle_job::lending_rate_task::Field::DepositRate),
                    "FIELD_BORROW_RATE" => Ok(oracle_job::lending_rate_task::Field::BorrowRate),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::LlmTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.provider_config.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LlmTask", len)?;
        if let Some(v) = self.provider_config.as_ref() {
            match v {
                oracle_job::llm_task::ProviderConfig::Openai(v) => {
                    struct_ser.serialize_field("openai", v)?;
                }
                oracle_job::llm_task::ProviderConfig::Groq(v) => {
                    struct_ser.serialize_field("groq", v)?;
                }
                oracle_job::llm_task::ProviderConfig::Grokxai(v) => {
                    struct_ser.serialize_field("grokxai", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::LlmTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "openai",
            "groq",
            "grokxai",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Openai,
            Groq,
            Grokxai,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "openai" => Ok(GeneratedField::Openai),
                            "groq" => Ok(GeneratedField::Groq),
                            "grokxai" => Ok(GeneratedField::Grokxai),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::LlmTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LlmTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::LlmTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut provider_config__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Openai => {
                            if provider_config__.is_some() {
                                return Err(serde::de::Error::duplicate_field("openai"));
                            }
                            provider_config__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::llm_task::ProviderConfig::Openai)
;
                        }
                        GeneratedField::Groq => {
                            if provider_config__.is_some() {
                                return Err(serde::de::Error::duplicate_field("groq"));
                            }
                            provider_config__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::llm_task::ProviderConfig::Groq)
;
                        }
                        GeneratedField::Grokxai => {
                            if provider_config__.is_some() {
                                return Err(serde::de::Error::duplicate_field("grokxai"));
                            }
                            provider_config__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::llm_task::ProviderConfig::Grokxai)
;
                        }
                    }
                }
                Ok(oracle_job::LlmTask {
                    provider_config: provider_config__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LlmTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::llm_task::GrokXaiConfig {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.model.is_some() {
            len += 1;
        }
        if self.user_prompt.is_some() {
            len += 1;
        }
        if self.temperature.is_some() {
            len += 1;
        }
        if self.secret_name_api_key.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LlmTask.GrokXAIConfig", len)?;
        if let Some(v) = self.model.as_ref() {
            struct_ser.serialize_field("model", v)?;
        }
        if let Some(v) = self.user_prompt.as_ref() {
            struct_ser.serialize_field("userPrompt", v)?;
        }
        if let Some(v) = self.temperature.as_ref() {
            struct_ser.serialize_field("temperature", v)?;
        }
        if let Some(v) = self.secret_name_api_key.as_ref() {
            struct_ser.serialize_field("secretNameApiKey", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::llm_task::GrokXaiConfig {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "model",
            "user_prompt",
            "userPrompt",
            "temperature",
            "secret_name_api_key",
            "secretNameApiKey",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Model,
            UserPrompt,
            Temperature,
            SecretNameApiKey,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "model" => Ok(GeneratedField::Model),
                            "userPrompt" | "user_prompt" => Ok(GeneratedField::UserPrompt),
                            "temperature" => Ok(GeneratedField::Temperature),
                            "secretNameApiKey" | "secret_name_api_key" => Ok(GeneratedField::SecretNameApiKey),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::llm_task::GrokXaiConfig;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LlmTask.GrokXAIConfig")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::llm_task::GrokXaiConfig, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut model__ = None;
                let mut user_prompt__ = None;
                let mut temperature__ = None;
                let mut secret_name_api_key__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Model => {
                            if model__.is_some() {
                                return Err(serde::de::Error::duplicate_field("model"));
                            }
                            model__ = map_.next_value()?;
                        }
                        GeneratedField::UserPrompt => {
                            if user_prompt__.is_some() {
                                return Err(serde::de::Error::duplicate_field("userPrompt"));
                            }
                            user_prompt__ = map_.next_value()?;
                        }
                        GeneratedField::Temperature => {
                            if temperature__.is_some() {
                                return Err(serde::de::Error::duplicate_field("temperature"));
                            }
                            temperature__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::SecretNameApiKey => {
                            if secret_name_api_key__.is_some() {
                                return Err(serde::de::Error::duplicate_field("secretNameApiKey"));
                            }
                            secret_name_api_key__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::llm_task::GrokXaiConfig {
                    model: model__,
                    user_prompt: user_prompt__,
                    temperature: temperature__,
                    secret_name_api_key: secret_name_api_key__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LlmTask.GrokXAIConfig", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::llm_task::GroqConfig {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.model.is_some() {
            len += 1;
        }
        if self.user_prompt.is_some() {
            len += 1;
        }
        if self.temperature.is_some() {
            len += 1;
        }
        if self.secret_name_api_key.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LlmTask.GroqConfig", len)?;
        if let Some(v) = self.model.as_ref() {
            struct_ser.serialize_field("model", v)?;
        }
        if let Some(v) = self.user_prompt.as_ref() {
            struct_ser.serialize_field("userPrompt", v)?;
        }
        if let Some(v) = self.temperature.as_ref() {
            struct_ser.serialize_field("temperature", v)?;
        }
        if let Some(v) = self.secret_name_api_key.as_ref() {
            struct_ser.serialize_field("secretNameApiKey", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::llm_task::GroqConfig {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "model",
            "user_prompt",
            "userPrompt",
            "temperature",
            "secret_name_api_key",
            "secretNameApiKey",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Model,
            UserPrompt,
            Temperature,
            SecretNameApiKey,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "model" => Ok(GeneratedField::Model),
                            "userPrompt" | "user_prompt" => Ok(GeneratedField::UserPrompt),
                            "temperature" => Ok(GeneratedField::Temperature),
                            "secretNameApiKey" | "secret_name_api_key" => Ok(GeneratedField::SecretNameApiKey),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::llm_task::GroqConfig;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LlmTask.GroqConfig")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::llm_task::GroqConfig, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut model__ = None;
                let mut user_prompt__ = None;
                let mut temperature__ = None;
                let mut secret_name_api_key__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Model => {
                            if model__.is_some() {
                                return Err(serde::de::Error::duplicate_field("model"));
                            }
                            model__ = map_.next_value()?;
                        }
                        GeneratedField::UserPrompt => {
                            if user_prompt__.is_some() {
                                return Err(serde::de::Error::duplicate_field("userPrompt"));
                            }
                            user_prompt__ = map_.next_value()?;
                        }
                        GeneratedField::Temperature => {
                            if temperature__.is_some() {
                                return Err(serde::de::Error::duplicate_field("temperature"));
                            }
                            temperature__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::SecretNameApiKey => {
                            if secret_name_api_key__.is_some() {
                                return Err(serde::de::Error::duplicate_field("secretNameApiKey"));
                            }
                            secret_name_api_key__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::llm_task::GroqConfig {
                    model: model__,
                    user_prompt: user_prompt__,
                    temperature: temperature__,
                    secret_name_api_key: secret_name_api_key__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LlmTask.GroqConfig", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::llm_task::OpenAiConfig {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.model.is_some() {
            len += 1;
        }
        if self.user_prompt.is_some() {
            len += 1;
        }
        if self.temperature.is_some() {
            len += 1;
        }
        if self.secret_name_api_key.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LlmTask.OpenAIConfig", len)?;
        if let Some(v) = self.model.as_ref() {
            struct_ser.serialize_field("model", v)?;
        }
        if let Some(v) = self.user_prompt.as_ref() {
            struct_ser.serialize_field("userPrompt", v)?;
        }
        if let Some(v) = self.temperature.as_ref() {
            struct_ser.serialize_field("temperature", v)?;
        }
        if let Some(v) = self.secret_name_api_key.as_ref() {
            struct_ser.serialize_field("secretNameApiKey", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::llm_task::OpenAiConfig {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "model",
            "user_prompt",
            "userPrompt",
            "temperature",
            "secret_name_api_key",
            "secretNameApiKey",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Model,
            UserPrompt,
            Temperature,
            SecretNameApiKey,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "model" => Ok(GeneratedField::Model),
                            "userPrompt" | "user_prompt" => Ok(GeneratedField::UserPrompt),
                            "temperature" => Ok(GeneratedField::Temperature),
                            "secretNameApiKey" | "secret_name_api_key" => Ok(GeneratedField::SecretNameApiKey),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::llm_task::OpenAiConfig;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LlmTask.OpenAIConfig")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::llm_task::OpenAiConfig, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut model__ = None;
                let mut user_prompt__ = None;
                let mut temperature__ = None;
                let mut secret_name_api_key__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Model => {
                            if model__.is_some() {
                                return Err(serde::de::Error::duplicate_field("model"));
                            }
                            model__ = map_.next_value()?;
                        }
                        GeneratedField::UserPrompt => {
                            if user_prompt__.is_some() {
                                return Err(serde::de::Error::duplicate_field("userPrompt"));
                            }
                            user_prompt__ = map_.next_value()?;
                        }
                        GeneratedField::Temperature => {
                            if temperature__.is_some() {
                                return Err(serde::de::Error::duplicate_field("temperature"));
                            }
                            temperature__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::SecretNameApiKey => {
                            if secret_name_api_key__.is_some() {
                                return Err(serde::de::Error::duplicate_field("secretNameApiKey"));
                            }
                            secret_name_api_key__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::llm_task::OpenAiConfig {
                    model: model__,
                    user_prompt: user_prompt__,
                    temperature: temperature__,
                    secret_name_api_key: secret_name_api_key__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LlmTask.OpenAIConfig", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::LpExchangeRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token_address.is_some() {
            len += 1;
        }
        if self.out_token_address.is_some() {
            len += 1;
        }
        if self.chain.is_some() {
            len += 1;
        }
        if self.pool_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LpExchangeRateTask", len)?;
        if let Some(v) = self.in_token_address.as_ref() {
            struct_ser.serialize_field("inTokenAddress", v)?;
        }
        if let Some(v) = self.out_token_address.as_ref() {
            struct_ser.serialize_field("outTokenAddress", v)?;
        }
        if let Some(v) = self.chain.as_ref() {
            let v = oracle_job::lp_exchange_rate_task::Chain::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("chain", &v)?;
        }
        if let Some(v) = self.pool_address.as_ref() {
            match v {
                oracle_job::lp_exchange_rate_task::PoolAddress::MercurialPoolAddress(v) => {
                    struct_ser.serialize_field("mercurialPoolAddress", v)?;
                }
                oracle_job::lp_exchange_rate_task::PoolAddress::SaberPoolAddress(v) => {
                    struct_ser.serialize_field("saberPoolAddress", v)?;
                }
                oracle_job::lp_exchange_rate_task::PoolAddress::OrcaPoolTokenMintAddress(v) => {
                    struct_ser.serialize_field("orcaPoolTokenMintAddress", v)?;
                }
                oracle_job::lp_exchange_rate_task::PoolAddress::RaydiumPoolAddress(v) => {
                    struct_ser.serialize_field("raydiumPoolAddress", v)?;
                }
                oracle_job::lp_exchange_rate_task::PoolAddress::OrcaPoolAddress(v) => {
                    struct_ser.serialize_field("orcaPoolAddress", v)?;
                }
                oracle_job::lp_exchange_rate_task::PoolAddress::PortReserveAddress(v) => {
                    struct_ser.serialize_field("portReserveAddress", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::LpExchangeRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token_address",
            "inTokenAddress",
            "out_token_address",
            "outTokenAddress",
            "chain",
            "mercurial_pool_address",
            "mercurialPoolAddress",
            "saber_pool_address",
            "saberPoolAddress",
            "orca_pool_token_mint_address",
            "orcaPoolTokenMintAddress",
            "raydium_pool_address",
            "raydiumPoolAddress",
            "orca_pool_address",
            "orcaPoolAddress",
            "port_reserve_address",
            "portReserveAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InTokenAddress,
            OutTokenAddress,
            Chain,
            MercurialPoolAddress,
            SaberPoolAddress,
            OrcaPoolTokenMintAddress,
            RaydiumPoolAddress,
            OrcaPoolAddress,
            PortReserveAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inTokenAddress" | "in_token_address" => Ok(GeneratedField::InTokenAddress),
                            "outTokenAddress" | "out_token_address" => Ok(GeneratedField::OutTokenAddress),
                            "chain" => Ok(GeneratedField::Chain),
                            "mercurialPoolAddress" | "mercurial_pool_address" => Ok(GeneratedField::MercurialPoolAddress),
                            "saberPoolAddress" | "saber_pool_address" => Ok(GeneratedField::SaberPoolAddress),
                            "orcaPoolTokenMintAddress" | "orca_pool_token_mint_address" => Ok(GeneratedField::OrcaPoolTokenMintAddress),
                            "raydiumPoolAddress" | "raydium_pool_address" => Ok(GeneratedField::RaydiumPoolAddress),
                            "orcaPoolAddress" | "orca_pool_address" => Ok(GeneratedField::OrcaPoolAddress),
                            "portReserveAddress" | "port_reserve_address" => Ok(GeneratedField::PortReserveAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::LpExchangeRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LpExchangeRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::LpExchangeRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token_address__ = None;
                let mut out_token_address__ = None;
                let mut chain__ = None;
                let mut pool_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InTokenAddress => {
                            if in_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAddress"));
                            }
                            in_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutTokenAddress => {
                            if out_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outTokenAddress"));
                            }
                            out_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::Chain => {
                            if chain__.is_some() {
                                return Err(serde::de::Error::duplicate_field("chain"));
                            }
                            chain__ = map_.next_value::<::std::option::Option<oracle_job::lp_exchange_rate_task::Chain>>()?.map(|x| x as i32);
                        }
                        GeneratedField::MercurialPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mercurialPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::MercurialPoolAddress);
                        }
                        GeneratedField::SaberPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("saberPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::SaberPoolAddress);
                        }
                        GeneratedField::OrcaPoolTokenMintAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("orcaPoolTokenMintAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::OrcaPoolTokenMintAddress);
                        }
                        GeneratedField::RaydiumPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("raydiumPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::RaydiumPoolAddress);
                        }
                        GeneratedField::OrcaPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("orcaPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::OrcaPoolAddress);
                        }
                        GeneratedField::PortReserveAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("portReserveAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_exchange_rate_task::PoolAddress::PortReserveAddress);
                        }
                    }
                }
                Ok(oracle_job::LpExchangeRateTask {
                    in_token_address: in_token_address__,
                    out_token_address: out_token_address__,
                    chain: chain__,
                    pool_address: pool_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LpExchangeRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::lp_exchange_rate_task::Chain {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Solana => "SOLANA",
            Self::Eclipse => "ECLIPSE",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::lp_exchange_rate_task::Chain {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "SOLANA",
            "ECLIPSE",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::lp_exchange_rate_task::Chain;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "SOLANA" => Ok(oracle_job::lp_exchange_rate_task::Chain::Solana),
                    "ECLIPSE" => Ok(oracle_job::lp_exchange_rate_task::Chain::Eclipse),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::LpTokenPriceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.price_feed_addresses.is_empty() {
            len += 1;
        }
        if !self.price_feed_jobs.is_empty() {
            len += 1;
        }
        if self.use_fair_price.is_some() {
            len += 1;
        }
        if self.pool_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LpTokenPriceTask", len)?;
        if !self.price_feed_addresses.is_empty() {
            struct_ser.serialize_field("priceFeedAddresses", &self.price_feed_addresses)?;
        }
        if !self.price_feed_jobs.is_empty() {
            struct_ser.serialize_field("priceFeedJobs", &self.price_feed_jobs)?;
        }
        if let Some(v) = self.use_fair_price.as_ref() {
            struct_ser.serialize_field("useFairPrice", v)?;
        }
        if let Some(v) = self.pool_address.as_ref() {
            match v {
                oracle_job::lp_token_price_task::PoolAddress::MercurialPoolAddress(v) => {
                    struct_ser.serialize_field("mercurialPoolAddress", v)?;
                }
                oracle_job::lp_token_price_task::PoolAddress::SaberPoolAddress(v) => {
                    struct_ser.serialize_field("saberPoolAddress", v)?;
                }
                oracle_job::lp_token_price_task::PoolAddress::OrcaPoolAddress(v) => {
                    struct_ser.serialize_field("orcaPoolAddress", v)?;
                }
                oracle_job::lp_token_price_task::PoolAddress::RaydiumPoolAddress(v) => {
                    struct_ser.serialize_field("raydiumPoolAddress", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::LpTokenPriceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "price_feed_addresses",
            "priceFeedAddresses",
            "price_feed_jobs",
            "priceFeedJobs",
            "use_fair_price",
            "useFairPrice",
            "mercurial_pool_address",
            "mercurialPoolAddress",
            "saber_pool_address",
            "saberPoolAddress",
            "orca_pool_address",
            "orcaPoolAddress",
            "raydium_pool_address",
            "raydiumPoolAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PriceFeedAddresses,
            PriceFeedJobs,
            UseFairPrice,
            MercurialPoolAddress,
            SaberPoolAddress,
            OrcaPoolAddress,
            RaydiumPoolAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "priceFeedAddresses" | "price_feed_addresses" => Ok(GeneratedField::PriceFeedAddresses),
                            "priceFeedJobs" | "price_feed_jobs" => Ok(GeneratedField::PriceFeedJobs),
                            "useFairPrice" | "use_fair_price" => Ok(GeneratedField::UseFairPrice),
                            "mercurialPoolAddress" | "mercurial_pool_address" => Ok(GeneratedField::MercurialPoolAddress),
                            "saberPoolAddress" | "saber_pool_address" => Ok(GeneratedField::SaberPoolAddress),
                            "orcaPoolAddress" | "orca_pool_address" => Ok(GeneratedField::OrcaPoolAddress),
                            "raydiumPoolAddress" | "raydium_pool_address" => Ok(GeneratedField::RaydiumPoolAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::LpTokenPriceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LpTokenPriceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::LpTokenPriceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut price_feed_addresses__ = None;
                let mut price_feed_jobs__ = None;
                let mut use_fair_price__ = None;
                let mut pool_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PriceFeedAddresses => {
                            if price_feed_addresses__.is_some() {
                                return Err(serde::de::Error::duplicate_field("priceFeedAddresses"));
                            }
                            price_feed_addresses__ = Some(map_.next_value()?);
                        }
                        GeneratedField::PriceFeedJobs => {
                            if price_feed_jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("priceFeedJobs"));
                            }
                            price_feed_jobs__ = Some(map_.next_value()?);
                        }
                        GeneratedField::UseFairPrice => {
                            if use_fair_price__.is_some() {
                                return Err(serde::de::Error::duplicate_field("useFairPrice"));
                            }
                            use_fair_price__ = map_.next_value()?;
                        }
                        GeneratedField::MercurialPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mercurialPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_token_price_task::PoolAddress::MercurialPoolAddress);
                        }
                        GeneratedField::SaberPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("saberPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_token_price_task::PoolAddress::SaberPoolAddress);
                        }
                        GeneratedField::OrcaPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("orcaPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_token_price_task::PoolAddress::OrcaPoolAddress);
                        }
                        GeneratedField::RaydiumPoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("raydiumPoolAddress"));
                            }
                            pool_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::lp_token_price_task::PoolAddress::RaydiumPoolAddress);
                        }
                    }
                }
                Ok(oracle_job::LpTokenPriceTask {
                    price_feed_addresses: price_feed_addresses__.unwrap_or_default(),
                    price_feed_jobs: price_feed_jobs__.unwrap_or_default(),
                    use_fair_price: use_fair_price__,
                    pool_address: pool_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LpTokenPriceTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::LstHistoricalYieldTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.lst_mint.is_some() {
            len += 1;
        }
        if self.operation.is_some() {
            len += 1;
        }
        if self.epochs.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.LstHistoricalYieldTask", len)?;
        if let Some(v) = self.lst_mint.as_ref() {
            struct_ser.serialize_field("lstMint", v)?;
        }
        if let Some(v) = self.operation.as_ref() {
            let v = oracle_job::lst_historical_yield_task::Operation::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("operation", &v)?;
        }
        if let Some(v) = self.epochs.as_ref() {
            struct_ser.serialize_field("epochs", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::LstHistoricalYieldTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "lst_mint",
            "lstMint",
            "operation",
            "epochs",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            LstMint,
            Operation,
            Epochs,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "lstMint" | "lst_mint" => Ok(GeneratedField::LstMint),
                            "operation" => Ok(GeneratedField::Operation),
                            "epochs" => Ok(GeneratedField::Epochs),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::LstHistoricalYieldTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.LstHistoricalYieldTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::LstHistoricalYieldTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut lst_mint__ = None;
                let mut operation__ = None;
                let mut epochs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::LstMint => {
                            if lst_mint__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lstMint"));
                            }
                            lst_mint__ = map_.next_value()?;
                        }
                        GeneratedField::Operation => {
                            if operation__.is_some() {
                                return Err(serde::de::Error::duplicate_field("operation"));
                            }
                            operation__ = map_.next_value::<::std::option::Option<oracle_job::lst_historical_yield_task::Operation>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Epochs => {
                            if epochs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("epochs"));
                            }
                            epochs__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::LstHistoricalYieldTask {
                    lst_mint: lst_mint__,
                    operation: operation__,
                    epochs: epochs__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.LstHistoricalYieldTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::lst_historical_yield_task::Operation {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Median => "OPERATION_MEDIAN",
            Self::Mean => "OPERATION_MEAN",
            Self::Min => "OPERATION_MIN",
            Self::Max => "OPERATION_MAX",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::lst_historical_yield_task::Operation {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "OPERATION_MEDIAN",
            "OPERATION_MEAN",
            "OPERATION_MIN",
            "OPERATION_MAX",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::lst_historical_yield_task::Operation;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "OPERATION_MEDIAN" => Ok(oracle_job::lst_historical_yield_task::Operation::Median),
                    "OPERATION_MEAN" => Ok(oracle_job::lst_historical_yield_task::Operation::Mean),
                    "OPERATION_MIN" => Ok(oracle_job::lst_historical_yield_task::Operation::Min),
                    "OPERATION_MAX" => Ok(oracle_job::lst_historical_yield_task::Operation::Max),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MangoPerpMarketTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.perp_market_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MangoPerpMarketTask", len)?;
        if let Some(v) = self.perp_market_address.as_ref() {
            struct_ser.serialize_field("perpMarketAddress", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MangoPerpMarketTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "perp_market_address",
            "perpMarketAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PerpMarketAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "perpMarketAddress" | "perp_market_address" => Ok(GeneratedField::PerpMarketAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MangoPerpMarketTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MangoPerpMarketTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MangoPerpMarketTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut perp_market_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PerpMarketAddress => {
                            if perp_market_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("perpMarketAddress"));
                            }
                            perp_market_address__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::MangoPerpMarketTask {
                    perp_market_address: perp_market_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MangoPerpMarketTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MapleFinanceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.method.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MapleFinanceTask", len)?;
        if let Some(v) = self.method.as_ref() {
            let v = oracle_job::maple_finance_task::Method::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("method", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MapleFinanceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "method",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Method,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "method" => Ok(GeneratedField::Method),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MapleFinanceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MapleFinanceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MapleFinanceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut method__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Method => {
                            if method__.is_some() {
                                return Err(serde::de::Error::duplicate_field("method"));
                            }
                            method__ = map_.next_value::<::std::option::Option<oracle_job::maple_finance_task::Method>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::MapleFinanceTask {
                    method: method__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MapleFinanceTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::maple_finance_task::Method {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::SyrupUsdcFairPrice => "METHOD_SYRUP_USDC_FAIR_PRICE",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::maple_finance_task::Method {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "METHOD_SYRUP_USDC_FAIR_PRICE",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::maple_finance_task::Method;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "METHOD_SYRUP_USDC_FAIR_PRICE" => Ok(oracle_job::maple_finance_task::Method::SyrupUsdcFairPrice),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MarinadeStateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let len = 0;
        let struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MarinadeStateTask", len)?;
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MarinadeStateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                            Err(serde::de::Error::unknown_field(value, FIELDS))
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MarinadeStateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MarinadeStateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MarinadeStateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                while map_.next_key::<GeneratedField>()?.is_some() {
                    let _ = map_.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(oracle_job::MarinadeStateTask {
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MarinadeStateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MaxTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.tasks.is_empty() {
            len += 1;
        }
        if !self.jobs.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MaxTask", len)?;
        if !self.tasks.is_empty() {
            struct_ser.serialize_field("tasks", &self.tasks)?;
        }
        if !self.jobs.is_empty() {
            struct_ser.serialize_field("jobs", &self.jobs)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MaxTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "tasks",
            "jobs",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Tasks,
            Jobs,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tasks" => Ok(GeneratedField::Tasks),
                            "jobs" => Ok(GeneratedField::Jobs),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MaxTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MaxTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MaxTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut tasks__ = None;
                let mut jobs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Tasks => {
                            if tasks__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tasks"));
                            }
                            tasks__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Jobs => {
                            if jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jobs"));
                            }
                            jobs__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::MaxTask {
                    tasks: tasks__.unwrap_or_default(),
                    jobs: jobs__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MaxTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MeanTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.tasks.is_empty() {
            len += 1;
        }
        if !self.jobs.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MeanTask", len)?;
        if !self.tasks.is_empty() {
            struct_ser.serialize_field("tasks", &self.tasks)?;
        }
        if !self.jobs.is_empty() {
            struct_ser.serialize_field("jobs", &self.jobs)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MeanTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "tasks",
            "jobs",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Tasks,
            Jobs,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tasks" => Ok(GeneratedField::Tasks),
                            "jobs" => Ok(GeneratedField::Jobs),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MeanTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MeanTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MeanTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut tasks__ = None;
                let mut jobs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Tasks => {
                            if tasks__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tasks"));
                            }
                            tasks__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Jobs => {
                            if jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jobs"));
                            }
                            jobs__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::MeanTask {
                    tasks: tasks__.unwrap_or_default(),
                    jobs: jobs__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MeanTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MedianTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.tasks.is_empty() {
            len += 1;
        }
        if !self.jobs.is_empty() {
            len += 1;
        }
        if self.min_successful_required.is_some() {
            len += 1;
        }
        if self.max_range_percent.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MedianTask", len)?;
        if !self.tasks.is_empty() {
            struct_ser.serialize_field("tasks", &self.tasks)?;
        }
        if !self.jobs.is_empty() {
            struct_ser.serialize_field("jobs", &self.jobs)?;
        }
        if let Some(v) = self.min_successful_required.as_ref() {
            struct_ser.serialize_field("minSuccessfulRequired", v)?;
        }
        if let Some(v) = self.max_range_percent.as_ref() {
            struct_ser.serialize_field("maxRangePercent", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MedianTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "tasks",
            "jobs",
            "min_successful_required",
            "minSuccessfulRequired",
            "max_range_percent",
            "maxRangePercent",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Tasks,
            Jobs,
            MinSuccessfulRequired,
            MaxRangePercent,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tasks" => Ok(GeneratedField::Tasks),
                            "jobs" => Ok(GeneratedField::Jobs),
                            "minSuccessfulRequired" | "min_successful_required" => Ok(GeneratedField::MinSuccessfulRequired),
                            "maxRangePercent" | "max_range_percent" => Ok(GeneratedField::MaxRangePercent),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MedianTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MedianTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MedianTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut tasks__ = None;
                let mut jobs__ = None;
                let mut min_successful_required__ = None;
                let mut max_range_percent__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Tasks => {
                            if tasks__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tasks"));
                            }
                            tasks__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Jobs => {
                            if jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jobs"));
                            }
                            jobs__ = Some(map_.next_value()?);
                        }
                        GeneratedField::MinSuccessfulRequired => {
                            if min_successful_required__.is_some() {
                                return Err(serde::de::Error::duplicate_field("minSuccessfulRequired"));
                            }
                            min_successful_required__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MaxRangePercent => {
                            if max_range_percent__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxRangePercent"));
                            }
                            max_range_percent__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::MedianTask {
                    tasks: tasks__.unwrap_or_default(),
                    jobs: jobs__.unwrap_or_default(),
                    min_successful_required: min_successful_required__,
                    max_range_percent: max_range_percent__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MedianTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MeteoraSwapTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pool.is_some() {
            len += 1;
        }
        if self.r#type.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MeteoraSwapTask", len)?;
        if let Some(v) = self.pool.as_ref() {
            struct_ser.serialize_field("pool", v)?;
        }
        if let Some(v) = self.r#type.as_ref() {
            let v = oracle_job::meteora_swap_task::Type::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("type", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MeteoraSwapTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pool",
            "type",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Pool,
            Type,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "pool" => Ok(GeneratedField::Pool),
                            "type" => Ok(GeneratedField::Type),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MeteoraSwapTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MeteoraSwapTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MeteoraSwapTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pool__ = None;
                let mut r#type__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Pool => {
                            if pool__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pool"));
                            }
                            pool__ = map_.next_value()?;
                        }
                        GeneratedField::Type => {
                            if r#type__.is_some() {
                                return Err(serde::de::Error::duplicate_field("type"));
                            }
                            r#type__ = map_.next_value::<::std::option::Option<oracle_job::meteora_swap_task::Type>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::MeteoraSwapTask {
                    pool: pool__,
                    r#type: r#type__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MeteoraSwapTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::meteora_swap_task::Type {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Dlmm => "TYPE_DLMM",
            Self::Standard => "TYPE_STANDARD",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::meteora_swap_task::Type {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "TYPE_DLMM",
            "TYPE_STANDARD",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::meteora_swap_task::Type;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "TYPE_DLMM" => Ok(oracle_job::meteora_swap_task::Type::Dlmm),
                    "TYPE_STANDARD" => Ok(oracle_job::meteora_swap_task::Type::Standard),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MinTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if !self.tasks.is_empty() {
            len += 1;
        }
        if !self.jobs.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MinTask", len)?;
        if !self.tasks.is_empty() {
            struct_ser.serialize_field("tasks", &self.tasks)?;
        }
        if !self.jobs.is_empty() {
            struct_ser.serialize_field("jobs", &self.jobs)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MinTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "tasks",
            "jobs",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Tasks,
            Jobs,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tasks" => Ok(GeneratedField::Tasks),
                            "jobs" => Ok(GeneratedField::Jobs),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MinTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MinTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MinTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut tasks__ = None;
                let mut jobs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Tasks => {
                            if tasks__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tasks"));
                            }
                            tasks__ = Some(map_.next_value()?);
                        }
                        GeneratedField::Jobs => {
                            if jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jobs"));
                            }
                            jobs__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::MinTask {
                    tasks: tasks__.unwrap_or_default(),
                    jobs: jobs__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MinTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::MultiplyTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.multiple.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.MultiplyTask", len)?;
        if let Some(v) = self.multiple.as_ref() {
            match v {
                oracle_job::multiply_task::Multiple::Scalar(v) => {
                    struct_ser.serialize_field("scalar", v)?;
                }
                oracle_job::multiply_task::Multiple::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::multiply_task::Multiple::Job(v) => {
                    struct_ser.serialize_field("job", v)?;
                }
                oracle_job::multiply_task::Multiple::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::MultiplyTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "scalar",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "job",
            "big",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Scalar,
            AggregatorPubkey,
            Job,
            Big,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "scalar" => Ok(GeneratedField::Scalar),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "job" => Ok(GeneratedField::Job),
                            "big" => Ok(GeneratedField::Big),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::MultiplyTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.MultiplyTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::MultiplyTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut multiple__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Scalar => {
                            if multiple__.is_some() {
                                return Err(serde::de::Error::duplicate_field("scalar"));
                            }
                            multiple__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::multiply_task::Multiple::Scalar(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if multiple__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            multiple__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::multiply_task::Multiple::AggregatorPubkey);
                        }
                        GeneratedField::Job => {
                            if multiple__.is_some() {
                                return Err(serde::de::Error::duplicate_field("job"));
                            }
                            multiple__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::multiply_task::Multiple::Job)
;
                        }
                        GeneratedField::Big => {
                            if multiple__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            multiple__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::multiply_task::Multiple::Big);
                        }
                    }
                }
                Ok(oracle_job::MultiplyTask {
                    multiple: multiple__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.MultiplyTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::OndoUsdyTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.strategy.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OndoUsdyTask", len)?;
        if let Some(v) = self.strategy.as_ref() {
            let v = oracle_job::ondo_usdy_task::Strategy::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("strategy", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::OndoUsdyTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "strategy",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Strategy,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "strategy" => Ok(GeneratedField::Strategy),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::OndoUsdyTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OndoUsdyTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::OndoUsdyTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut strategy__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Strategy => {
                            if strategy__.is_some() {
                                return Err(serde::de::Error::duplicate_field("strategy"));
                            }
                            strategy__ = map_.next_value::<::std::option::Option<oracle_job::ondo_usdy_task::Strategy>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::OndoUsdyTask {
                    strategy: strategy__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OndoUsdyTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ondo_usdy_task::Strategy {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::FairValue => "STRATEGY_FAIR_VALUE",
            Self::Market => "STRATEGY_MARKET",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ondo_usdy_task::Strategy {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "STRATEGY_FAIR_VALUE",
            "STRATEGY_MARKET",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ondo_usdy_task::Strategy;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "STRATEGY_FAIR_VALUE" => Ok(oracle_job::ondo_usdy_task::Strategy::FairValue),
                    "STRATEGY_MARKET" => Ok(oracle_job::ondo_usdy_task::Strategy::Market),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::OracleTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pyth_allowed_confidence_interval.is_some() {
            len += 1;
        }
        if self.chainlink_configs.is_some() {
            len += 1;
        }
        if self.pyth_configs.is_some() {
            len += 1;
        }
        if self.switchboard_configs.is_some() {
            len += 1;
        }
        if self.edge_configs.is_some() {
            len += 1;
        }
        if self.redstone_configs.is_some() {
            len += 1;
        }
        if self.aggregator_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask", len)?;
        if let Some(v) = self.pyth_allowed_confidence_interval.as_ref() {
            struct_ser.serialize_field("pythAllowedConfidenceInterval", v)?;
        }
        if let Some(v) = self.chainlink_configs.as_ref() {
            struct_ser.serialize_field("chainlinkConfigs", v)?;
        }
        if let Some(v) = self.pyth_configs.as_ref() {
            struct_ser.serialize_field("pythConfigs", v)?;
        }
        if let Some(v) = self.switchboard_configs.as_ref() {
            struct_ser.serialize_field("switchboardConfigs", v)?;
        }
        if let Some(v) = self.edge_configs.as_ref() {
            struct_ser.serialize_field("edgeConfigs", v)?;
        }
        if let Some(v) = self.redstone_configs.as_ref() {
            struct_ser.serialize_field("redstoneConfigs", v)?;
        }
        if let Some(v) = self.aggregator_address.as_ref() {
            match v {
                oracle_job::oracle_task::AggregatorAddress::SwitchboardAddress(v) => {
                    struct_ser.serialize_field("switchboardAddress", v)?;
                }
                oracle_job::oracle_task::AggregatorAddress::PythAddress(v) => {
                    struct_ser.serialize_field("pythAddress", v)?;
                }
                oracle_job::oracle_task::AggregatorAddress::ChainlinkAddress(v) => {
                    struct_ser.serialize_field("chainlinkAddress", v)?;
                }
                oracle_job::oracle_task::AggregatorAddress::EdgeId(v) => {
                    struct_ser.serialize_field("edgeId", v)?;
                }
                oracle_job::oracle_task::AggregatorAddress::RedstoneId(v) => {
                    struct_ser.serialize_field("redstoneId", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::OracleTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pyth_allowed_confidence_interval",
            "pythAllowedConfidenceInterval",
            "chainlink_configs",
            "chainlinkConfigs",
            "pyth_configs",
            "pythConfigs",
            "switchboard_configs",
            "switchboardConfigs",
            "edge_configs",
            "edgeConfigs",
            "redstone_configs",
            "redstoneConfigs",
            "switchboard_address",
            "switchboardAddress",
            "pyth_address",
            "pythAddress",
            "chainlink_address",
            "chainlinkAddress",
            "edge_id",
            "edgeId",
            "redstone_id",
            "redstoneId",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PythAllowedConfidenceInterval,
            ChainlinkConfigs,
            PythConfigs,
            SwitchboardConfigs,
            EdgeConfigs,
            RedstoneConfigs,
            SwitchboardAddress,
            PythAddress,
            ChainlinkAddress,
            EdgeId,
            RedstoneId,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "pythAllowedConfidenceInterval" | "pyth_allowed_confidence_interval" => Ok(GeneratedField::PythAllowedConfidenceInterval),
                            "chainlinkConfigs" | "chainlink_configs" => Ok(GeneratedField::ChainlinkConfigs),
                            "pythConfigs" | "pyth_configs" => Ok(GeneratedField::PythConfigs),
                            "switchboardConfigs" | "switchboard_configs" => Ok(GeneratedField::SwitchboardConfigs),
                            "edgeConfigs" | "edge_configs" => Ok(GeneratedField::EdgeConfigs),
                            "redstoneConfigs" | "redstone_configs" => Ok(GeneratedField::RedstoneConfigs),
                            "switchboardAddress" | "switchboard_address" => Ok(GeneratedField::SwitchboardAddress),
                            "pythAddress" | "pyth_address" => Ok(GeneratedField::PythAddress),
                            "chainlinkAddress" | "chainlink_address" => Ok(GeneratedField::ChainlinkAddress),
                            "edgeId" | "edge_id" => Ok(GeneratedField::EdgeId),
                            "redstoneId" | "redstone_id" => Ok(GeneratedField::RedstoneId),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::OracleTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::OracleTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pyth_allowed_confidence_interval__ = None;
                let mut chainlink_configs__ = None;
                let mut pyth_configs__ = None;
                let mut switchboard_configs__ = None;
                let mut edge_configs__ = None;
                let mut redstone_configs__ = None;
                let mut aggregator_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PythAllowedConfidenceInterval => {
                            if pyth_allowed_confidence_interval__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pythAllowedConfidenceInterval"));
                            }
                            pyth_allowed_confidence_interval__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::ChainlinkConfigs => {
                            if chainlink_configs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("chainlinkConfigs"));
                            }
                            chainlink_configs__ = map_.next_value()?;
                        }
                        GeneratedField::PythConfigs => {
                            if pyth_configs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pythConfigs"));
                            }
                            pyth_configs__ = map_.next_value()?;
                        }
                        GeneratedField::SwitchboardConfigs => {
                            if switchboard_configs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("switchboardConfigs"));
                            }
                            switchboard_configs__ = map_.next_value()?;
                        }
                        GeneratedField::EdgeConfigs => {
                            if edge_configs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("edgeConfigs"));
                            }
                            edge_configs__ = map_.next_value()?;
                        }
                        GeneratedField::RedstoneConfigs => {
                            if redstone_configs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("redstoneConfigs"));
                            }
                            redstone_configs__ = map_.next_value()?;
                        }
                        GeneratedField::SwitchboardAddress => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("switchboardAddress"));
                            }
                            aggregator_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::oracle_task::AggregatorAddress::SwitchboardAddress);
                        }
                        GeneratedField::PythAddress => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pythAddress"));
                            }
                            aggregator_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::oracle_task::AggregatorAddress::PythAddress);
                        }
                        GeneratedField::ChainlinkAddress => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("chainlinkAddress"));
                            }
                            aggregator_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::oracle_task::AggregatorAddress::ChainlinkAddress);
                        }
                        GeneratedField::EdgeId => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("edgeId"));
                            }
                            aggregator_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::oracle_task::AggregatorAddress::EdgeId);
                        }
                        GeneratedField::RedstoneId => {
                            if aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("redstoneId"));
                            }
                            aggregator_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::oracle_task::AggregatorAddress::RedstoneId);
                        }
                    }
                }
                Ok(oracle_job::OracleTask {
                    pyth_allowed_confidence_interval: pyth_allowed_confidence_interval__,
                    chainlink_configs: chainlink_configs__,
                    pyth_configs: pyth_configs__,
                    switchboard_configs: switchboard_configs__,
                    edge_configs: edge_configs__,
                    redstone_configs: redstone_configs__,
                    aggregator_address: aggregator_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::oracle_task::ChainlinkConfigs {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.provider.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask.ChainlinkConfigs", len)?;
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::oracle_task::ChainlinkConfigs {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "provider",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Provider,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "provider" => Ok(GeneratedField::Provider),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::oracle_task::ChainlinkConfigs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask.ChainlinkConfigs")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::oracle_task::ChainlinkConfigs, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut provider__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::oracle_task::ChainlinkConfigs {
                    provider: provider__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask.ChainlinkConfigs", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::oracle_task::EdgeConfigs {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let len = 0;
        let struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask.EdgeConfigs", len)?;
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::oracle_task::EdgeConfigs {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                            Err(serde::de::Error::unknown_field(value, FIELDS))
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::oracle_task::EdgeConfigs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask.EdgeConfigs")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::oracle_task::EdgeConfigs, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                while map_.next_key::<GeneratedField>()?.is_some() {
                    let _ = map_.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(oracle_job::oracle_task::EdgeConfigs {
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask.EdgeConfigs", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::oracle_task::PythConfigs {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.hermes_url.is_some() {
            len += 1;
        }
        if self.pyth_allowed_confidence_interval.is_some() {
            len += 1;
        }
        if self.max_stale_seconds.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask.PythConfigs", len)?;
        if let Some(v) = self.hermes_url.as_ref() {
            struct_ser.serialize_field("hermesUrl", v)?;
        }
        if let Some(v) = self.pyth_allowed_confidence_interval.as_ref() {
            struct_ser.serialize_field("pythAllowedConfidenceInterval", v)?;
        }
        if let Some(v) = self.max_stale_seconds.as_ref() {
            struct_ser.serialize_field("maxStaleSeconds", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::oracle_task::PythConfigs {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "hermes_url",
            "hermesUrl",
            "pyth_allowed_confidence_interval",
            "pythAllowedConfidenceInterval",
            "max_stale_seconds",
            "maxStaleSeconds",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            HermesUrl,
            PythAllowedConfidenceInterval,
            MaxStaleSeconds,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "hermesUrl" | "hermes_url" => Ok(GeneratedField::HermesUrl),
                            "pythAllowedConfidenceInterval" | "pyth_allowed_confidence_interval" => Ok(GeneratedField::PythAllowedConfidenceInterval),
                            "maxStaleSeconds" | "max_stale_seconds" => Ok(GeneratedField::MaxStaleSeconds),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::oracle_task::PythConfigs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask.PythConfigs")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::oracle_task::PythConfigs, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut hermes_url__ = None;
                let mut pyth_allowed_confidence_interval__ = None;
                let mut max_stale_seconds__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::HermesUrl => {
                            if hermes_url__.is_some() {
                                return Err(serde::de::Error::duplicate_field("hermesUrl"));
                            }
                            hermes_url__ = map_.next_value()?;
                        }
                        GeneratedField::PythAllowedConfidenceInterval => {
                            if pyth_allowed_confidence_interval__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pythAllowedConfidenceInterval"));
                            }
                            pyth_allowed_confidence_interval__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MaxStaleSeconds => {
                            if max_stale_seconds__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxStaleSeconds"));
                            }
                            max_stale_seconds__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::oracle_task::PythConfigs {
                    hermes_url: hermes_url__,
                    pyth_allowed_confidence_interval: pyth_allowed_confidence_interval__,
                    max_stale_seconds: max_stale_seconds__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask.PythConfigs", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::oracle_task::RedstoneConfigs {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let len = 0;
        let struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask.RedstoneConfigs", len)?;
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::oracle_task::RedstoneConfigs {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                            Err(serde::de::Error::unknown_field(value, FIELDS))
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::oracle_task::RedstoneConfigs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask.RedstoneConfigs")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::oracle_task::RedstoneConfigs, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                while map_.next_key::<GeneratedField>()?.is_some() {
                    let _ = map_.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(oracle_job::oracle_task::RedstoneConfigs {
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask.RedstoneConfigs", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::oracle_task::SwitchboardConfigs {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.version.is_some() {
            len += 1;
        }
        if !self.jobs.is_empty() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.OracleTask.SwitchboardConfigs", len)?;
        if let Some(v) = self.version.as_ref() {
            struct_ser.serialize_field("version", v)?;
        }
        if !self.jobs.is_empty() {
            struct_ser.serialize_field("jobs", &self.jobs)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::oracle_task::SwitchboardConfigs {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "version",
            "jobs",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Version,
            Jobs,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "version" => Ok(GeneratedField::Version),
                            "jobs" => Ok(GeneratedField::Jobs),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::oracle_task::SwitchboardConfigs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.OracleTask.SwitchboardConfigs")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::oracle_task::SwitchboardConfigs, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut version__ = None;
                let mut jobs__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Version => {
                            if version__.is_some() {
                                return Err(serde::de::Error::duplicate_field("version"));
                            }
                            version__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Jobs => {
                            if jobs__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jobs"));
                            }
                            jobs__ = Some(map_.next_value()?);
                        }
                    }
                }
                Ok(oracle_job::oracle_task::SwitchboardConfigs {
                    version: version__,
                    jobs: jobs__.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.OracleTask.SwitchboardConfigs", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::PancakeswapExchangeRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token_address.is_some() {
            len += 1;
        }
        if self.out_token_address.is_some() {
            len += 1;
        }
        if self.in_token_amount.is_some() {
            len += 1;
        }
        if self.slippage.is_some() {
            len += 1;
        }
        if self.provider.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.PancakeswapExchangeRateTask", len)?;
        if let Some(v) = self.in_token_address.as_ref() {
            struct_ser.serialize_field("inTokenAddress", v)?;
        }
        if let Some(v) = self.out_token_address.as_ref() {
            struct_ser.serialize_field("outTokenAddress", v)?;
        }
        if let Some(v) = self.in_token_amount.as_ref() {
            struct_ser.serialize_field("inTokenAmount", v)?;
        }
        if let Some(v) = self.slippage.as_ref() {
            struct_ser.serialize_field("slippage", v)?;
        }
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::PancakeswapExchangeRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token_address",
            "inTokenAddress",
            "out_token_address",
            "outTokenAddress",
            "in_token_amount",
            "inTokenAmount",
            "slippage",
            "provider",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InTokenAddress,
            OutTokenAddress,
            InTokenAmount,
            Slippage,
            Provider,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inTokenAddress" | "in_token_address" => Ok(GeneratedField::InTokenAddress),
                            "outTokenAddress" | "out_token_address" => Ok(GeneratedField::OutTokenAddress),
                            "inTokenAmount" | "in_token_amount" => Ok(GeneratedField::InTokenAmount),
                            "slippage" => Ok(GeneratedField::Slippage),
                            "provider" => Ok(GeneratedField::Provider),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::PancakeswapExchangeRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.PancakeswapExchangeRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::PancakeswapExchangeRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token_address__ = None;
                let mut out_token_address__ = None;
                let mut in_token_amount__ = None;
                let mut slippage__ = None;
                let mut provider__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InTokenAddress => {
                            if in_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAddress"));
                            }
                            in_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutTokenAddress => {
                            if out_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outTokenAddress"));
                            }
                            out_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::InTokenAmount => {
                            if in_token_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAmount"));
                            }
                            in_token_amount__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Slippage => {
                            if slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("slippage"));
                            }
                            slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::PancakeswapExchangeRateTask {
                    in_token_address: in_token_address__,
                    out_token_address: out_token_address__,
                    in_token_amount: in_token_amount__,
                    slippage: slippage__,
                    provider: provider__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.PancakeswapExchangeRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::PerpMarketTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.market_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.PerpMarketTask", len)?;
        if let Some(v) = self.market_address.as_ref() {
            match v {
                oracle_job::perp_market_task::MarketAddress::MangoMarketAddress(v) => {
                    struct_ser.serialize_field("mangoMarketAddress", v)?;
                }
                oracle_job::perp_market_task::MarketAddress::DriftMarketAddress(v) => {
                    struct_ser.serialize_field("driftMarketAddress", v)?;
                }
                oracle_job::perp_market_task::MarketAddress::ZetaMarketAddress(v) => {
                    struct_ser.serialize_field("zetaMarketAddress", v)?;
                }
                oracle_job::perp_market_task::MarketAddress::ZoMarketAddress(v) => {
                    struct_ser.serialize_field("zoMarketAddress", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::PerpMarketTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "mango_market_address",
            "mangoMarketAddress",
            "drift_market_address",
            "driftMarketAddress",
            "zeta_market_address",
            "zetaMarketAddress",
            "zo_market_address",
            "zoMarketAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            MangoMarketAddress,
            DriftMarketAddress,
            ZetaMarketAddress,
            ZoMarketAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "mangoMarketAddress" | "mango_market_address" => Ok(GeneratedField::MangoMarketAddress),
                            "driftMarketAddress" | "drift_market_address" => Ok(GeneratedField::DriftMarketAddress),
                            "zetaMarketAddress" | "zeta_market_address" => Ok(GeneratedField::ZetaMarketAddress),
                            "zoMarketAddress" | "zo_market_address" => Ok(GeneratedField::ZoMarketAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::PerpMarketTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.PerpMarketTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::PerpMarketTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut market_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::MangoMarketAddress => {
                            if market_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mangoMarketAddress"));
                            }
                            market_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::perp_market_task::MarketAddress::MangoMarketAddress);
                        }
                        GeneratedField::DriftMarketAddress => {
                            if market_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("driftMarketAddress"));
                            }
                            market_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::perp_market_task::MarketAddress::DriftMarketAddress);
                        }
                        GeneratedField::ZetaMarketAddress => {
                            if market_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("zetaMarketAddress"));
                            }
                            market_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::perp_market_task::MarketAddress::ZetaMarketAddress);
                        }
                        GeneratedField::ZoMarketAddress => {
                            if market_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("zoMarketAddress"));
                            }
                            market_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::perp_market_task::MarketAddress::ZoMarketAddress);
                        }
                    }
                }
                Ok(oracle_job::PerpMarketTask {
                    market_address: market_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.PerpMarketTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::PowTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.exponent.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.PowTask", len)?;
        if let Some(v) = self.exponent.as_ref() {
            match v {
                oracle_job::pow_task::Exponent::Scalar(v) => {
                    struct_ser.serialize_field("scalar", v)?;
                }
                oracle_job::pow_task::Exponent::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::pow_task::Exponent::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::PowTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "scalar",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "big",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Scalar,
            AggregatorPubkey,
            Big,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "scalar" => Ok(GeneratedField::Scalar),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "big" => Ok(GeneratedField::Big),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::PowTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.PowTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::PowTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut exponent__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Scalar => {
                            if exponent__.is_some() {
                                return Err(serde::de::Error::duplicate_field("scalar"));
                            }
                            exponent__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::pow_task::Exponent::Scalar(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if exponent__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            exponent__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::pow_task::Exponent::AggregatorPubkey);
                        }
                        GeneratedField::Big => {
                            if exponent__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            exponent__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::pow_task::Exponent::Big);
                        }
                    }
                }
                Ok(oracle_job::PowTask {
                    exponent: exponent__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.PowTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::PumpAmmLpTokenPriceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.x_price_job.is_some() {
            len += 1;
        }
        if self.y_price_job.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.PumpAmmLpTokenPriceTask", len)?;
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.x_price_job.as_ref() {
            struct_ser.serialize_field("xPriceJob", v)?;
        }
        if let Some(v) = self.y_price_job.as_ref() {
            struct_ser.serialize_field("yPriceJob", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::PumpAmmLpTokenPriceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pool_address",
            "poolAddress",
            "x_price_job",
            "xPriceJob",
            "y_price_job",
            "yPriceJob",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PoolAddress,
            XPriceJob,
            YPriceJob,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "xPriceJob" | "x_price_job" => Ok(GeneratedField::XPriceJob),
                            "yPriceJob" | "y_price_job" => Ok(GeneratedField::YPriceJob),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::PumpAmmLpTokenPriceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.PumpAmmLpTokenPriceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::PumpAmmLpTokenPriceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pool_address__ = None;
                let mut x_price_job__ = None;
                let mut y_price_job__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::XPriceJob => {
                            if x_price_job__.is_some() {
                                return Err(serde::de::Error::duplicate_field("xPriceJob"));
                            }
                            x_price_job__ = map_.next_value()?;
                        }
                        GeneratedField::YPriceJob => {
                            if y_price_job__.is_some() {
                                return Err(serde::de::Error::duplicate_field("yPriceJob"));
                            }
                            y_price_job__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::PumpAmmLpTokenPriceTask {
                    pool_address: pool_address__,
                    x_price_job: x_price_job__,
                    y_price_job: y_price_job__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.PumpAmmLpTokenPriceTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::PumpAmmTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pool_address.is_some() {
            len += 1;
        }
        if self.in_amount.is_some() {
            len += 1;
        }
        if self.max_slippage.is_some() {
            len += 1;
        }
        if self.is_x_for_y.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.PumpAmmTask", len)?;
        if let Some(v) = self.pool_address.as_ref() {
            struct_ser.serialize_field("poolAddress", v)?;
        }
        if let Some(v) = self.in_amount.as_ref() {
            struct_ser.serialize_field("inAmount", v)?;
        }
        if let Some(v) = self.max_slippage.as_ref() {
            struct_ser.serialize_field("maxSlippage", v)?;
        }
        if let Some(v) = self.is_x_for_y.as_ref() {
            struct_ser.serialize_field("isXForY", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::PumpAmmTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pool_address",
            "poolAddress",
            "in_amount",
            "inAmount",
            "max_slippage",
            "maxSlippage",
            "is_x_for_y",
            "isXForY",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PoolAddress,
            InAmount,
            MaxSlippage,
            IsXForY,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "poolAddress" | "pool_address" => Ok(GeneratedField::PoolAddress),
                            "inAmount" | "in_amount" => Ok(GeneratedField::InAmount),
                            "maxSlippage" | "max_slippage" => Ok(GeneratedField::MaxSlippage),
                            "isXForY" | "is_x_for_y" => Ok(GeneratedField::IsXForY),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::PumpAmmTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.PumpAmmTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::PumpAmmTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pool_address__ = None;
                let mut in_amount__ = None;
                let mut max_slippage__ = None;
                let mut is_x_for_y__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PoolAddress => {
                            if pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("poolAddress"));
                            }
                            pool_address__ = map_.next_value()?;
                        }
                        GeneratedField::InAmount => {
                            if in_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inAmount"));
                            }
                            in_amount__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::MaxSlippage => {
                            if max_slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxSlippage"));
                            }
                            max_slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::IsXForY => {
                            if is_x_for_y__.is_some() {
                                return Err(serde::de::Error::duplicate_field("isXForY"));
                            }
                            is_x_for_y__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::PumpAmmTask {
                    pool_address: pool_address__,
                    in_amount: in_amount__,
                    max_slippage: max_slippage__,
                    is_x_for_y: is_x_for_y__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.PumpAmmTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::RegexExtractTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pattern.is_some() {
            len += 1;
        }
        if self.group_number.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.RegexExtractTask", len)?;
        if let Some(v) = self.pattern.as_ref() {
            struct_ser.serialize_field("pattern", v)?;
        }
        if let Some(v) = self.group_number.as_ref() {
            struct_ser.serialize_field("groupNumber", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::RegexExtractTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pattern",
            "group_number",
            "groupNumber",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Pattern,
            GroupNumber,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "pattern" => Ok(GeneratedField::Pattern),
                            "groupNumber" | "group_number" => Ok(GeneratedField::GroupNumber),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::RegexExtractTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.RegexExtractTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::RegexExtractTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pattern__ = None;
                let mut group_number__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Pattern => {
                            if pattern__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pattern"));
                            }
                            pattern__ = map_.next_value()?;
                        }
                        GeneratedField::GroupNumber => {
                            if group_number__.is_some() {
                                return Err(serde::de::Error::duplicate_field("groupNumber"));
                            }
                            group_number__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::RegexExtractTask {
                    pattern: pattern__,
                    group_number: group_number__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.RegexExtractTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::RoundTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.method.is_some() {
            len += 1;
        }
        if self.decimals.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.RoundTask", len)?;
        if let Some(v) = self.method.as_ref() {
            let v = oracle_job::round_task::Method::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("method", &v)?;
        }
        if let Some(v) = self.decimals.as_ref() {
            struct_ser.serialize_field("decimals", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::RoundTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "method",
            "decimals",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Method,
            Decimals,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "method" => Ok(GeneratedField::Method),
                            "decimals" => Ok(GeneratedField::Decimals),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::RoundTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.RoundTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::RoundTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut method__ = None;
                let mut decimals__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Method => {
                            if method__.is_some() {
                                return Err(serde::de::Error::duplicate_field("method"));
                            }
                            method__ = map_.next_value::<::std::option::Option<oracle_job::round_task::Method>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Decimals => {
                            if decimals__.is_some() {
                                return Err(serde::de::Error::duplicate_field("decimals"));
                            }
                            decimals__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::RoundTask {
                    method: method__,
                    decimals: decimals__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.RoundTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::round_task::Method {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::RoundUp => "METHOD_ROUND_UP",
            Self::RoundDown => "METHOD_ROUND_DOWN",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::round_task::Method {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "METHOD_ROUND_UP",
            "METHOD_ROUND_DOWN",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::round_task::Method;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "METHOD_ROUND_UP" => Ok(oracle_job::round_task::Method::RoundUp),
                    "METHOD_ROUND_DOWN" => Ok(oracle_job::round_task::Method::RoundDown),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SanctumLstPriceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.lst_mint.is_some() {
            len += 1;
        }
        if self.skip_epoch_check.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SanctumLstPriceTask", len)?;
        if let Some(v) = self.lst_mint.as_ref() {
            struct_ser.serialize_field("lstMint", v)?;
        }
        if let Some(v) = self.skip_epoch_check.as_ref() {
            struct_ser.serialize_field("skipEpochCheck", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SanctumLstPriceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "lst_mint",
            "lstMint",
            "skip_epoch_check",
            "skipEpochCheck",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            LstMint,
            SkipEpochCheck,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "lstMint" | "lst_mint" => Ok(GeneratedField::LstMint),
                            "skipEpochCheck" | "skip_epoch_check" => Ok(GeneratedField::SkipEpochCheck),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SanctumLstPriceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SanctumLstPriceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SanctumLstPriceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut lst_mint__ = None;
                let mut skip_epoch_check__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::LstMint => {
                            if lst_mint__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lstMint"));
                            }
                            lst_mint__ = map_.next_value()?;
                        }
                        GeneratedField::SkipEpochCheck => {
                            if skip_epoch_check__.is_some() {
                                return Err(serde::de::Error::duplicate_field("skipEpochCheck"));
                            }
                            skip_epoch_check__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SanctumLstPriceTask {
                    lst_mint: lst_mint__,
                    skip_epoch_check: skip_epoch_check__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SanctumLstPriceTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SecretsTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.authority.is_some() {
            len += 1;
        }
        if self.url.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SecretsTask", len)?;
        if let Some(v) = self.authority.as_ref() {
            struct_ser.serialize_field("authority", v)?;
        }
        if let Some(v) = self.url.as_ref() {
            struct_ser.serialize_field("url", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SecretsTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "authority",
            "url",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Authority,
            Url,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "authority" => Ok(GeneratedField::Authority),
                            "url" => Ok(GeneratedField::Url),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SecretsTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SecretsTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SecretsTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut authority__ = None;
                let mut url__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Authority => {
                            if authority__.is_some() {
                                return Err(serde::de::Error::duplicate_field("authority"));
                            }
                            authority__ = map_.next_value()?;
                        }
                        GeneratedField::Url => {
                            if url__.is_some() {
                                return Err(serde::de::Error::duplicate_field("url"));
                            }
                            url__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SecretsTask {
                    authority: authority__,
                    url: url__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SecretsTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SerumSwapTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.serum_pool_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SerumSwapTask", len)?;
        if let Some(v) = self.serum_pool_address.as_ref() {
            struct_ser.serialize_field("serumPoolAddress", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SerumSwapTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "serum_pool_address",
            "serumPoolAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            SerumPoolAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "serumPoolAddress" | "serum_pool_address" => Ok(GeneratedField::SerumPoolAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SerumSwapTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SerumSwapTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SerumSwapTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut serum_pool_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::SerumPoolAddress => {
                            if serum_pool_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("serumPoolAddress"));
                            }
                            serum_pool_address__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SerumSwapTask {
                    serum_pool_address: serum_pool_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SerumSwapTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SolanaAccountDataFetchTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pubkey.is_some() {
            len += 1;
        }
        if self.network.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SolanaAccountDataFetchTask", len)?;
        if let Some(v) = self.pubkey.as_ref() {
            struct_ser.serialize_field("pubkey", v)?;
        }
        if let Some(v) = self.network.as_ref() {
            let v = oracle_job::solana_account_data_fetch_task::Network::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("network", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SolanaAccountDataFetchTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pubkey",
            "network",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Pubkey,
            Network,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "pubkey" => Ok(GeneratedField::Pubkey),
                            "network" => Ok(GeneratedField::Network),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SolanaAccountDataFetchTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SolanaAccountDataFetchTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SolanaAccountDataFetchTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pubkey__ = None;
                let mut network__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Pubkey => {
                            if pubkey__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pubkey"));
                            }
                            pubkey__ = map_.next_value()?;
                        }
                        GeneratedField::Network => {
                            if network__.is_some() {
                                return Err(serde::de::Error::duplicate_field("network"));
                            }
                            network__ = map_.next_value::<::std::option::Option<oracle_job::solana_account_data_fetch_task::Network>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::SolanaAccountDataFetchTask {
                    pubkey: pubkey__,
                    network: network__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SolanaAccountDataFetchTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::solana_account_data_fetch_task::Network {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Mainnet => "NETWORK_MAINNET",
            Self::Testnet => "NETWORK_TESTNET",
            Self::Devnet => "NETWORK_DEVNET",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::solana_account_data_fetch_task::Network {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "NETWORK_MAINNET",
            "NETWORK_TESTNET",
            "NETWORK_DEVNET",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::solana_account_data_fetch_task::Network;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "NETWORK_MAINNET" => Ok(oracle_job::solana_account_data_fetch_task::Network::Mainnet),
                    "NETWORK_TESTNET" => Ok(oracle_job::solana_account_data_fetch_task::Network::Testnet),
                    "NETWORK_DEVNET" => Ok(oracle_job::solana_account_data_fetch_task::Network::Devnet),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SolanaToken2022ExtensionTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.mint.is_some() {
            len += 1;
        }
        if self.extension.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SolanaToken2022ExtensionTask", len)?;
        if let Some(v) = self.mint.as_ref() {
            struct_ser.serialize_field("mint", v)?;
        }
        if let Some(v) = self.extension.as_ref() {
            let v = oracle_job::solana_token2022_extension_task::Token2022Extension::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("extension", &v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SolanaToken2022ExtensionTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "mint",
            "extension",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Mint,
            Extension,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "mint" => Ok(GeneratedField::Mint),
                            "extension" => Ok(GeneratedField::Extension),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SolanaToken2022ExtensionTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SolanaToken2022ExtensionTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SolanaToken2022ExtensionTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut mint__ = None;
                let mut extension__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Mint => {
                            if mint__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mint"));
                            }
                            mint__ = map_.next_value()?;
                        }
                        GeneratedField::Extension => {
                            if extension__.is_some() {
                                return Err(serde::de::Error::duplicate_field("extension"));
                            }
                            extension__ = map_.next_value::<::std::option::Option<oracle_job::solana_token2022_extension_task::Token2022Extension>>()?.map(|x| x as i32);
                        }
                    }
                }
                Ok(oracle_job::SolanaToken2022ExtensionTask {
                    mint: mint__,
                    extension: extension__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SolanaToken2022ExtensionTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::solana_token2022_extension_task::Token2022Extension {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Token2022ScaledAmountFactor => "TOKEN_2022_SCALED_AMOUNT_FACTOR",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::solana_token2022_extension_task::Token2022Extension {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "TOKEN_2022_SCALED_AMOUNT_FACTOR",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::solana_token2022_extension_task::Token2022Extension;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "TOKEN_2022_SCALED_AMOUNT_FACTOR" => Ok(oracle_job::solana_token2022_extension_task::Token2022Extension::Token2022ScaledAmountFactor),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SolayerSusdTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let len = 0;
        let struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SolayerSusdTask", len)?;
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SolayerSusdTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                            Err(serde::de::Error::unknown_field(value, FIELDS))
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SolayerSusdTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SolayerSusdTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SolayerSusdTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                while map_.next_key::<GeneratedField>()?.is_some() {
                    let _ = map_.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(oracle_job::SolayerSusdTask {
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SolayerSusdTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SplStakePoolTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.pubkey.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SplStakePoolTask", len)?;
        if let Some(v) = self.pubkey.as_ref() {
            struct_ser.serialize_field("pubkey", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SplStakePoolTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "pubkey",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Pubkey,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "pubkey" => Ok(GeneratedField::Pubkey),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SplStakePoolTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SplStakePoolTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SplStakePoolTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut pubkey__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Pubkey => {
                            if pubkey__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pubkey"));
                            }
                            pubkey__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SplStakePoolTask {
                    pubkey: pubkey__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SplStakePoolTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SplTokenParseTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.account_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SplTokenParseTask", len)?;
        if let Some(v) = self.account_address.as_ref() {
            match v {
                oracle_job::spl_token_parse_task::AccountAddress::TokenAccountAddress(v) => {
                    struct_ser.serialize_field("tokenAccountAddress", v)?;
                }
                oracle_job::spl_token_parse_task::AccountAddress::MintAddress(v) => {
                    struct_ser.serialize_field("mintAddress", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SplTokenParseTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "token_account_address",
            "tokenAccountAddress",
            "mint_address",
            "mintAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            TokenAccountAddress,
            MintAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "tokenAccountAddress" | "token_account_address" => Ok(GeneratedField::TokenAccountAddress),
                            "mintAddress" | "mint_address" => Ok(GeneratedField::MintAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SplTokenParseTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SplTokenParseTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SplTokenParseTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut account_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::TokenAccountAddress => {
                            if account_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("tokenAccountAddress"));
                            }
                            account_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::spl_token_parse_task::AccountAddress::TokenAccountAddress);
                        }
                        GeneratedField::MintAddress => {
                            if account_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mintAddress"));
                            }
                            account_address__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::spl_token_parse_task::AccountAddress::MintAddress);
                        }
                    }
                }
                Ok(oracle_job::SplTokenParseTask {
                    account_address: account_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SplTokenParseTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SubtractTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.subtraction.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SubtractTask", len)?;
        if let Some(v) = self.subtraction.as_ref() {
            match v {
                oracle_job::subtract_task::Subtraction::Scalar(v) => {
                    struct_ser.serialize_field("scalar", v)?;
                }
                oracle_job::subtract_task::Subtraction::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::subtract_task::Subtraction::Job(v) => {
                    struct_ser.serialize_field("job", v)?;
                }
                oracle_job::subtract_task::Subtraction::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SubtractTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "scalar",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "job",
            "big",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Scalar,
            AggregatorPubkey,
            Job,
            Big,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "scalar" => Ok(GeneratedField::Scalar),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "job" => Ok(GeneratedField::Job),
                            "big" => Ok(GeneratedField::Big),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SubtractTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SubtractTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SubtractTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut subtraction__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Scalar => {
                            if subtraction__.is_some() {
                                return Err(serde::de::Error::duplicate_field("scalar"));
                            }
                            subtraction__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::subtract_task::Subtraction::Scalar(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if subtraction__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            subtraction__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::subtract_task::Subtraction::AggregatorPubkey);
                        }
                        GeneratedField::Job => {
                            if subtraction__.is_some() {
                                return Err(serde::de::Error::duplicate_field("job"));
                            }
                            subtraction__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::subtract_task::Subtraction::Job)
;
                        }
                        GeneratedField::Big => {
                            if subtraction__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            subtraction__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::subtract_task::Subtraction::Big);
                        }
                    }
                }
                Ok(oracle_job::SubtractTask {
                    subtraction: subtraction__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SubtractTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SushiswapExchangeRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token_address.is_some() {
            len += 1;
        }
        if self.out_token_address.is_some() {
            len += 1;
        }
        if self.in_token_amount.is_some() {
            len += 1;
        }
        if self.slippage.is_some() {
            len += 1;
        }
        if self.provider.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SushiswapExchangeRateTask", len)?;
        if let Some(v) = self.in_token_address.as_ref() {
            struct_ser.serialize_field("inTokenAddress", v)?;
        }
        if let Some(v) = self.out_token_address.as_ref() {
            struct_ser.serialize_field("outTokenAddress", v)?;
        }
        if let Some(v) = self.in_token_amount.as_ref() {
            struct_ser.serialize_field("inTokenAmount", v)?;
        }
        if let Some(v) = self.slippage.as_ref() {
            struct_ser.serialize_field("slippage", v)?;
        }
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SushiswapExchangeRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token_address",
            "inTokenAddress",
            "out_token_address",
            "outTokenAddress",
            "in_token_amount",
            "inTokenAmount",
            "slippage",
            "provider",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InTokenAddress,
            OutTokenAddress,
            InTokenAmount,
            Slippage,
            Provider,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inTokenAddress" | "in_token_address" => Ok(GeneratedField::InTokenAddress),
                            "outTokenAddress" | "out_token_address" => Ok(GeneratedField::OutTokenAddress),
                            "inTokenAmount" | "in_token_amount" => Ok(GeneratedField::InTokenAmount),
                            "slippage" => Ok(GeneratedField::Slippage),
                            "provider" => Ok(GeneratedField::Provider),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SushiswapExchangeRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SushiswapExchangeRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SushiswapExchangeRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token_address__ = None;
                let mut out_token_address__ = None;
                let mut in_token_amount__ = None;
                let mut slippage__ = None;
                let mut provider__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InTokenAddress => {
                            if in_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAddress"));
                            }
                            in_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutTokenAddress => {
                            if out_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outTokenAddress"));
                            }
                            out_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::InTokenAmount => {
                            if in_token_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAmount"));
                            }
                            in_token_amount__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Slippage => {
                            if slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("slippage"));
                            }
                            slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SushiswapExchangeRateTask {
                    in_token_address: in_token_address__,
                    out_token_address: out_token_address__,
                    in_token_amount: in_token_amount__,
                    slippage: slippage__,
                    provider: provider__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SushiswapExchangeRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SwitchboardSurgeTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.source.is_some() {
            len += 1;
        }
        if self.symbol.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SwitchboardSurgeTask", len)?;
        if let Some(v) = self.source.as_ref() {
            let v = oracle_job::switchboard_surge_task::Source::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("source", &v)?;
        }
        if let Some(v) = self.symbol.as_ref() {
            struct_ser.serialize_field("symbol", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SwitchboardSurgeTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "source",
            "symbol",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Source,
            Symbol,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "source" => Ok(GeneratedField::Source),
                            "symbol" => Ok(GeneratedField::Symbol),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SwitchboardSurgeTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SwitchboardSurgeTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SwitchboardSurgeTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut source__ = None;
                let mut symbol__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Source => {
                            if source__.is_some() {
                                return Err(serde::de::Error::duplicate_field("source"));
                            }
                            source__ = map_.next_value::<::std::option::Option<oracle_job::switchboard_surge_task::Source>>()?.map(|x| x as i32);
                        }
                        GeneratedField::Symbol => {
                            if symbol__.is_some() {
                                return Err(serde::de::Error::duplicate_field("symbol"));
                            }
                            symbol__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::SwitchboardSurgeTask {
                    source: source__,
                    symbol: symbol__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SwitchboardSurgeTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::switchboard_surge_task::Source {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::Weighted => "WEIGHTED",
            Self::Binance => "BINANCE",
            Self::Okx => "OKX",
            Self::Bybit => "BYBIT",
            Self::Coinbase => "COINBASE",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::switchboard_surge_task::Source {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "WEIGHTED",
            "BINANCE",
            "OKX",
            "BYBIT",
            "COINBASE",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::switchboard_surge_task::Source;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "WEIGHTED" => Ok(oracle_job::switchboard_surge_task::Source::Weighted),
                    "BINANCE" => Ok(oracle_job::switchboard_surge_task::Source::Binance),
                    "OKX" => Ok(oracle_job::switchboard_surge_task::Source::Okx),
                    "BYBIT" => Ok(oracle_job::switchboard_surge_task::Source::Bybit),
                    "COINBASE" => Ok(oracle_job::switchboard_surge_task::Source::Coinbase),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::SysclockOffsetTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let len = 0;
        let struct_ser = serializer.serialize_struct("oracle_job.OracleJob.SysclockOffsetTask", len)?;
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::SysclockOffsetTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                            Err(serde::de::Error::unknown_field(value, FIELDS))
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::SysclockOffsetTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.SysclockOffsetTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::SysclockOffsetTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                while map_.next_key::<GeneratedField>()?.is_some() {
                    let _ = map_.next_value::<serde::de::IgnoredAny>()?;
                }
                Ok(oracle_job::SysclockOffsetTask {
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.SysclockOffsetTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::Task {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.task.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.Task", len)?;
        if let Some(v) = self.task.as_ref() {
            match v {
                oracle_job::task::Task::HttpTask(v) => {
                    struct_ser.serialize_field("httpTask", v)?;
                }
                oracle_job::task::Task::JsonParseTask(v) => {
                    struct_ser.serialize_field("jsonParseTask", v)?;
                }
                oracle_job::task::Task::MedianTask(v) => {
                    struct_ser.serialize_field("medianTask", v)?;
                }
                oracle_job::task::Task::MeanTask(v) => {
                    struct_ser.serialize_field("meanTask", v)?;
                }
                oracle_job::task::Task::WebsocketTask(v) => {
                    struct_ser.serialize_field("websocketTask", v)?;
                }
                oracle_job::task::Task::DivideTask(v) => {
                    struct_ser.serialize_field("divideTask", v)?;
                }
                oracle_job::task::Task::MultiplyTask(v) => {
                    struct_ser.serialize_field("multiplyTask", v)?;
                }
                oracle_job::task::Task::LpTokenPriceTask(v) => {
                    struct_ser.serialize_field("lpTokenPriceTask", v)?;
                }
                oracle_job::task::Task::LpExchangeRateTask(v) => {
                    struct_ser.serialize_field("lpExchangeRateTask", v)?;
                }
                oracle_job::task::Task::ConditionalTask(v) => {
                    struct_ser.serialize_field("conditionalTask", v)?;
                }
                oracle_job::task::Task::ValueTask(v) => {
                    struct_ser.serialize_field("valueTask", v)?;
                }
                oracle_job::task::Task::MaxTask(v) => {
                    struct_ser.serialize_field("maxTask", v)?;
                }
                oracle_job::task::Task::RegexExtractTask(v) => {
                    struct_ser.serialize_field("regexExtractTask", v)?;
                }
                oracle_job::task::Task::XstepPriceTask(v) => {
                    struct_ser.serialize_field("xstepPriceTask", v)?;
                }
                oracle_job::task::Task::AddTask(v) => {
                    struct_ser.serialize_field("addTask", v)?;
                }
                oracle_job::task::Task::SubtractTask(v) => {
                    struct_ser.serialize_field("subtractTask", v)?;
                }
                oracle_job::task::Task::TwapTask(v) => {
                    struct_ser.serialize_field("twapTask", v)?;
                }
                oracle_job::task::Task::SerumSwapTask(v) => {
                    struct_ser.serialize_field("serumSwapTask", v)?;
                }
                oracle_job::task::Task::PowTask(v) => {
                    struct_ser.serialize_field("powTask", v)?;
                }
                oracle_job::task::Task::LendingRateTask(v) => {
                    struct_ser.serialize_field("lendingRateTask", v)?;
                }
                oracle_job::task::Task::MangoPerpMarketTask(v) => {
                    struct_ser.serialize_field("mangoPerpMarketTask", v)?;
                }
                oracle_job::task::Task::JupiterSwapTask(v) => {
                    struct_ser.serialize_field("jupiterSwapTask", v)?;
                }
                oracle_job::task::Task::PerpMarketTask(v) => {
                    struct_ser.serialize_field("perpMarketTask", v)?;
                }
                oracle_job::task::Task::OracleTask(v) => {
                    struct_ser.serialize_field("oracleTask", v)?;
                }
                oracle_job::task::Task::AnchorFetchTask(v) => {
                    struct_ser.serialize_field("anchorFetchTask", v)?;
                }
                oracle_job::task::Task::SplStakePoolTask(v) => {
                    struct_ser.serialize_field("splStakePoolTask", v)?;
                }
                oracle_job::task::Task::SplTokenParseTask(v) => {
                    struct_ser.serialize_field("splTokenParseTask", v)?;
                }
                oracle_job::task::Task::UniswapExchangeRateTask(v) => {
                    struct_ser.serialize_field("uniswapExchangeRateTask", v)?;
                }
                oracle_job::task::Task::SushiswapExchangeRateTask(v) => {
                    struct_ser.serialize_field("sushiswapExchangeRateTask", v)?;
                }
                oracle_job::task::Task::PancakeswapExchangeRateTask(v) => {
                    struct_ser.serialize_field("pancakeswapExchangeRateTask", v)?;
                }
                oracle_job::task::Task::CacheTask(v) => {
                    struct_ser.serialize_field("cacheTask", v)?;
                }
                oracle_job::task::Task::SysclockOffsetTask(v) => {
                    struct_ser.serialize_field("sysclockOffsetTask", v)?;
                }
                oracle_job::task::Task::MarinadeStateTask(v) => {
                    struct_ser.serialize_field("marinadeStateTask", v)?;
                }
                oracle_job::task::Task::SolanaAccountDataFetchTask(v) => {
                    struct_ser.serialize_field("solanaAccountDataFetchTask", v)?;
                }
                oracle_job::task::Task::BufferLayoutParseTask(v) => {
                    struct_ser.serialize_field("bufferLayoutParseTask", v)?;
                }
                oracle_job::task::Task::CronParseTask(v) => {
                    struct_ser.serialize_field("cronParseTask", v)?;
                }
                oracle_job::task::Task::MinTask(v) => {
                    struct_ser.serialize_field("minTask", v)?;
                }
                oracle_job::task::Task::HistoryFunctionTask(v) => {
                    struct_ser.serialize_field("historyFunctionTask", v)?;
                }
                oracle_job::task::Task::VwapTask(v) => {
                    struct_ser.serialize_field("vwapTask", v)?;
                }
                oracle_job::task::Task::EwmaTask(v) => {
                    struct_ser.serialize_field("ewmaTask", v)?;
                }
                oracle_job::task::Task::ComparisonTask(v) => {
                    struct_ser.serialize_field("comparisonTask", v)?;
                }
                oracle_job::task::Task::RoundTask(v) => {
                    struct_ser.serialize_field("roundTask", v)?;
                }
                oracle_job::task::Task::BoundTask(v) => {
                    struct_ser.serialize_field("boundTask", v)?;
                }
                oracle_job::task::Task::SecretsTask(v) => {
                    struct_ser.serialize_field("secretsTask", v)?;
                }
                oracle_job::task::Task::SanctumLstPriceTask(v) => {
                    struct_ser.serialize_field("sanctumLstPriceTask", v)?;
                }
                oracle_job::task::Task::OndoUsdyTask(v) => {
                    struct_ser.serialize_field("ondoUsdyTask", v)?;
                }
                oracle_job::task::Task::MeteoraSwapTask(v) => {
                    struct_ser.serialize_field("meteoraSwapTask", v)?;
                }
                oracle_job::task::Task::UnixTimeTask(v) => {
                    struct_ser.serialize_field("unixTimeTask", v)?;
                }
                oracle_job::task::Task::MapleFinanceTask(v) => {
                    struct_ser.serialize_field("mapleFinanceTask", v)?;
                }
                oracle_job::task::Task::GlyphTask(v) => {
                    struct_ser.serialize_field("glyphTask", v)?;
                }
                oracle_job::task::Task::CorexTask(v) => {
                    struct_ser.serialize_field("corexTask", v)?;
                }
                oracle_job::task::Task::LlmTask(v) => {
                    struct_ser.serialize_field("llmTask", v)?;
                }
                oracle_job::task::Task::SolayerSusdTask(v) => {
                    struct_ser.serialize_field("solayerSusdTask", v)?;
                }
                oracle_job::task::Task::CurveFinanceTask(v) => {
                    struct_ser.serialize_field("curveFinanceTask", v)?;
                }
                oracle_job::task::Task::TurboEthRedemptionRateTask(v) => {
                    struct_ser.serialize_field("turboEthRedemptionRateTask", v)?;
                }
                oracle_job::task::Task::BitFluxTask(v) => {
                    struct_ser.serialize_field("bitFluxTask", v)?;
                }
                oracle_job::task::Task::FragmetricTask(v) => {
                    struct_ser.serialize_field("fragmetricTask", v)?;
                }
                oracle_job::task::Task::AftermathTask(v) => {
                    struct_ser.serialize_field("aftermathTask", v)?;
                }
                oracle_job::task::Task::EtherfuseTask(v) => {
                    struct_ser.serialize_field("etherfuseTask", v)?;
                }
                oracle_job::task::Task::LstHistoricalYieldTask(v) => {
                    struct_ser.serialize_field("lstHistoricalYieldTask", v)?;
                }
                oracle_job::task::Task::PumpAmmTask(v) => {
                    struct_ser.serialize_field("pumpAmmTask", v)?;
                }
                oracle_job::task::Task::PumpAmmLpTokenPriceTask(v) => {
                    struct_ser.serialize_field("pumpAmmLpTokenPriceTask", v)?;
                }
                oracle_job::task::Task::ExponentTask(v) => {
                    struct_ser.serialize_field("exponentTask", v)?;
                }
                oracle_job::task::Task::ExponentPtLinearPricingTask(v) => {
                    struct_ser.serialize_field("exponentPtLinearPricingTask", v)?;
                }
                oracle_job::task::Task::SolanaToken2022ExtensionTask(v) => {
                    struct_ser.serialize_field("solanaToken2022ExtensionTask", v)?;
                }
                oracle_job::task::Task::SwitchboardSurgeTask(v) => {
                    struct_ser.serialize_field("switchboardSurgeTask", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::Task {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "http_task",
            "httpTask",
            "json_parse_task",
            "jsonParseTask",
            "median_task",
            "medianTask",
            "mean_task",
            "meanTask",
            "websocket_task",
            "websocketTask",
            "divide_task",
            "divideTask",
            "multiply_task",
            "multiplyTask",
            "lp_token_price_task",
            "lpTokenPriceTask",
            "lp_exchange_rate_task",
            "lpExchangeRateTask",
            "conditional_task",
            "conditionalTask",
            "value_task",
            "valueTask",
            "max_task",
            "maxTask",
            "regex_extract_task",
            "regexExtractTask",
            "xstep_price_task",
            "xstepPriceTask",
            "add_task",
            "addTask",
            "subtract_task",
            "subtractTask",
            "twap_task",
            "twapTask",
            "serum_swap_task",
            "serumSwapTask",
            "pow_task",
            "powTask",
            "lending_rate_task",
            "lendingRateTask",
            "mango_perp_market_task",
            "mangoPerpMarketTask",
            "jupiter_swap_task",
            "jupiterSwapTask",
            "perp_market_task",
            "perpMarketTask",
            "oracle_task",
            "oracleTask",
            "anchor_fetch_task",
            "anchorFetchTask",
            "spl_stake_pool_task",
            "splStakePoolTask",
            "spl_token_parse_task",
            "splTokenParseTask",
            "uniswap_exchange_rate_task",
            "uniswapExchangeRateTask",
            "sushiswap_exchange_rate_task",
            "sushiswapExchangeRateTask",
            "pancakeswap_exchange_rate_task",
            "pancakeswapExchangeRateTask",
            "cache_task",
            "cacheTask",
            "sysclock_offset_task",
            "sysclockOffsetTask",
            "marinade_state_task",
            "marinadeStateTask",
            "solana_account_data_fetch_task",
            "solanaAccountDataFetchTask",
            "buffer_layout_parse_task",
            "bufferLayoutParseTask",
            "cron_parse_task",
            "cronParseTask",
            "min_task",
            "minTask",
            "history_function_task",
            "historyFunctionTask",
            "vwap_task",
            "vwapTask",
            "ewma_task",
            "ewmaTask",
            "comparison_task",
            "comparisonTask",
            "round_task",
            "roundTask",
            "bound_task",
            "boundTask",
            "secrets_task",
            "secretsTask",
            "sanctum_lst_price_task",
            "sanctumLstPriceTask",
            "ondo_usdy_task",
            "ondoUsdyTask",
            "meteora_swap_task",
            "meteoraSwapTask",
            "unix_time_task",
            "unixTimeTask",
            "maple_finance_task",
            "mapleFinanceTask",
            "glyph_task",
            "glyphTask",
            "corex_task",
            "corexTask",
            "llm_task",
            "llmTask",
            "solayer_susd_task",
            "solayerSusdTask",
            "curve_finance_task",
            "curveFinanceTask",
            "turbo_eth_redemption_rate_task",
            "turboEthRedemptionRateTask",
            "bit_flux_task",
            "bitFluxTask",
            "fragmetric_task",
            "fragmetricTask",
            "aftermath_task",
            "aftermathTask",
            "etherfuse_task",
            "etherfuseTask",
            "lst_historical_yield_task",
            "lstHistoricalYieldTask",
            "pump_amm_task",
            "pumpAmmTask",
            "pump_amm_lp_token_price_task",
            "pumpAmmLpTokenPriceTask",
            "exponent_task",
            "exponentTask",
            "exponent_pt_linear_pricing_task",
            "exponentPtLinearPricingTask",
            "solana_token_2022_extension_task",
            "solanaToken2022ExtensionTask",
            "switchboard_surge_task",
            "switchboardSurgeTask",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            HttpTask,
            JsonParseTask,
            MedianTask,
            MeanTask,
            WebsocketTask,
            DivideTask,
            MultiplyTask,
            LpTokenPriceTask,
            LpExchangeRateTask,
            ConditionalTask,
            ValueTask,
            MaxTask,
            RegexExtractTask,
            XstepPriceTask,
            AddTask,
            SubtractTask,
            TwapTask,
            SerumSwapTask,
            PowTask,
            LendingRateTask,
            MangoPerpMarketTask,
            JupiterSwapTask,
            PerpMarketTask,
            OracleTask,
            AnchorFetchTask,
            SplStakePoolTask,
            SplTokenParseTask,
            UniswapExchangeRateTask,
            SushiswapExchangeRateTask,
            PancakeswapExchangeRateTask,
            CacheTask,
            SysclockOffsetTask,
            MarinadeStateTask,
            SolanaAccountDataFetchTask,
            BufferLayoutParseTask,
            CronParseTask,
            MinTask,
            HistoryFunctionTask,
            VwapTask,
            EwmaTask,
            ComparisonTask,
            RoundTask,
            BoundTask,
            SecretsTask,
            SanctumLstPriceTask,
            OndoUsdyTask,
            MeteoraSwapTask,
            UnixTimeTask,
            MapleFinanceTask,
            GlyphTask,
            CorexTask,
            LlmTask,
            SolayerSusdTask,
            CurveFinanceTask,
            TurboEthRedemptionRateTask,
            BitFluxTask,
            FragmetricTask,
            AftermathTask,
            EtherfuseTask,
            LstHistoricalYieldTask,
            PumpAmmTask,
            PumpAmmLpTokenPriceTask,
            ExponentTask,
            ExponentPtLinearPricingTask,
            SolanaToken2022ExtensionTask,
            SwitchboardSurgeTask,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "httpTask" | "http_task" => Ok(GeneratedField::HttpTask),
                            "jsonParseTask" | "json_parse_task" => Ok(GeneratedField::JsonParseTask),
                            "medianTask" | "median_task" => Ok(GeneratedField::MedianTask),
                            "meanTask" | "mean_task" => Ok(GeneratedField::MeanTask),
                            "websocketTask" | "websocket_task" => Ok(GeneratedField::WebsocketTask),
                            "divideTask" | "divide_task" => Ok(GeneratedField::DivideTask),
                            "multiplyTask" | "multiply_task" => Ok(GeneratedField::MultiplyTask),
                            "lpTokenPriceTask" | "lp_token_price_task" => Ok(GeneratedField::LpTokenPriceTask),
                            "lpExchangeRateTask" | "lp_exchange_rate_task" => Ok(GeneratedField::LpExchangeRateTask),
                            "conditionalTask" | "conditional_task" => Ok(GeneratedField::ConditionalTask),
                            "valueTask" | "value_task" => Ok(GeneratedField::ValueTask),
                            "maxTask" | "max_task" => Ok(GeneratedField::MaxTask),
                            "regexExtractTask" | "regex_extract_task" => Ok(GeneratedField::RegexExtractTask),
                            "xstepPriceTask" | "xstep_price_task" => Ok(GeneratedField::XstepPriceTask),
                            "addTask" | "add_task" => Ok(GeneratedField::AddTask),
                            "subtractTask" | "subtract_task" => Ok(GeneratedField::SubtractTask),
                            "twapTask" | "twap_task" => Ok(GeneratedField::TwapTask),
                            "serumSwapTask" | "serum_swap_task" => Ok(GeneratedField::SerumSwapTask),
                            "powTask" | "pow_task" => Ok(GeneratedField::PowTask),
                            "lendingRateTask" | "lending_rate_task" => Ok(GeneratedField::LendingRateTask),
                            "mangoPerpMarketTask" | "mango_perp_market_task" => Ok(GeneratedField::MangoPerpMarketTask),
                            "jupiterSwapTask" | "jupiter_swap_task" => Ok(GeneratedField::JupiterSwapTask),
                            "perpMarketTask" | "perp_market_task" => Ok(GeneratedField::PerpMarketTask),
                            "oracleTask" | "oracle_task" => Ok(GeneratedField::OracleTask),
                            "anchorFetchTask" | "anchor_fetch_task" => Ok(GeneratedField::AnchorFetchTask),
                            "splStakePoolTask" | "spl_stake_pool_task" => Ok(GeneratedField::SplStakePoolTask),
                            "splTokenParseTask" | "spl_token_parse_task" => Ok(GeneratedField::SplTokenParseTask),
                            "uniswapExchangeRateTask" | "uniswap_exchange_rate_task" => Ok(GeneratedField::UniswapExchangeRateTask),
                            "sushiswapExchangeRateTask" | "sushiswap_exchange_rate_task" => Ok(GeneratedField::SushiswapExchangeRateTask),
                            "pancakeswapExchangeRateTask" | "pancakeswap_exchange_rate_task" => Ok(GeneratedField::PancakeswapExchangeRateTask),
                            "cacheTask" | "cache_task" => Ok(GeneratedField::CacheTask),
                            "sysclockOffsetTask" | "sysclock_offset_task" => Ok(GeneratedField::SysclockOffsetTask),
                            "marinadeStateTask" | "marinade_state_task" => Ok(GeneratedField::MarinadeStateTask),
                            "solanaAccountDataFetchTask" | "solana_account_data_fetch_task" => Ok(GeneratedField::SolanaAccountDataFetchTask),
                            "bufferLayoutParseTask" | "buffer_layout_parse_task" => Ok(GeneratedField::BufferLayoutParseTask),
                            "cronParseTask" | "cron_parse_task" => Ok(GeneratedField::CronParseTask),
                            "minTask" | "min_task" => Ok(GeneratedField::MinTask),
                            "historyFunctionTask" | "history_function_task" => Ok(GeneratedField::HistoryFunctionTask),
                            "vwapTask" | "vwap_task" => Ok(GeneratedField::VwapTask),
                            "ewmaTask" | "ewma_task" => Ok(GeneratedField::EwmaTask),
                            "comparisonTask" | "comparison_task" => Ok(GeneratedField::ComparisonTask),
                            "roundTask" | "round_task" => Ok(GeneratedField::RoundTask),
                            "boundTask" | "bound_task" => Ok(GeneratedField::BoundTask),
                            "secretsTask" | "secrets_task" => Ok(GeneratedField::SecretsTask),
                            "sanctumLstPriceTask" | "sanctum_lst_price_task" => Ok(GeneratedField::SanctumLstPriceTask),
                            "ondoUsdyTask" | "ondo_usdy_task" => Ok(GeneratedField::OndoUsdyTask),
                            "meteoraSwapTask" | "meteora_swap_task" => Ok(GeneratedField::MeteoraSwapTask),
                            "unixTimeTask" | "unix_time_task" => Ok(GeneratedField::UnixTimeTask),
                            "mapleFinanceTask" | "maple_finance_task" => Ok(GeneratedField::MapleFinanceTask),
                            "glyphTask" | "glyph_task" => Ok(GeneratedField::GlyphTask),
                            "corexTask" | "corex_task" => Ok(GeneratedField::CorexTask),
                            "llmTask" | "llm_task" => Ok(GeneratedField::LlmTask),
                            "solayerSusdTask" | "solayer_susd_task" => Ok(GeneratedField::SolayerSusdTask),
                            "curveFinanceTask" | "curve_finance_task" => Ok(GeneratedField::CurveFinanceTask),
                            "turboEthRedemptionRateTask" | "turbo_eth_redemption_rate_task" => Ok(GeneratedField::TurboEthRedemptionRateTask),
                            "bitFluxTask" | "bit_flux_task" => Ok(GeneratedField::BitFluxTask),
                            "fragmetricTask" | "fragmetric_task" => Ok(GeneratedField::FragmetricTask),
                            "aftermathTask" | "aftermath_task" => Ok(GeneratedField::AftermathTask),
                            "etherfuseTask" | "etherfuse_task" => Ok(GeneratedField::EtherfuseTask),
                            "lstHistoricalYieldTask" | "lst_historical_yield_task" => Ok(GeneratedField::LstHistoricalYieldTask),
                            "pumpAmmTask" | "pump_amm_task" => Ok(GeneratedField::PumpAmmTask),
                            "pumpAmmLpTokenPriceTask" | "pump_amm_lp_token_price_task" => Ok(GeneratedField::PumpAmmLpTokenPriceTask),
                            "exponentTask" | "exponent_task" => Ok(GeneratedField::ExponentTask),
                            "exponentPtLinearPricingTask" | "exponent_pt_linear_pricing_task" => Ok(GeneratedField::ExponentPtLinearPricingTask),
                            "solanaToken2022ExtensionTask" | "solana_token_2022_extension_task" => Ok(GeneratedField::SolanaToken2022ExtensionTask),
                            "switchboardSurgeTask" | "switchboard_surge_task" => Ok(GeneratedField::SwitchboardSurgeTask),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::Task;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.Task")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::Task, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut task__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::HttpTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("httpTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::HttpTask)
;
                        }
                        GeneratedField::JsonParseTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jsonParseTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::JsonParseTask)
;
                        }
                        GeneratedField::MedianTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("medianTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MedianTask)
;
                        }
                        GeneratedField::MeanTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("meanTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MeanTask)
;
                        }
                        GeneratedField::WebsocketTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("websocketTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::WebsocketTask)
;
                        }
                        GeneratedField::DivideTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("divideTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::DivideTask)
;
                        }
                        GeneratedField::MultiplyTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("multiplyTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MultiplyTask)
;
                        }
                        GeneratedField::LpTokenPriceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lpTokenPriceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::LpTokenPriceTask)
;
                        }
                        GeneratedField::LpExchangeRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lpExchangeRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::LpExchangeRateTask)
;
                        }
                        GeneratedField::ConditionalTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("conditionalTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::ConditionalTask)
;
                        }
                        GeneratedField::ValueTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("valueTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::ValueTask)
;
                        }
                        GeneratedField::MaxTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MaxTask)
;
                        }
                        GeneratedField::RegexExtractTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("regexExtractTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::RegexExtractTask)
;
                        }
                        GeneratedField::XstepPriceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("xstepPriceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::XstepPriceTask)
;
                        }
                        GeneratedField::AddTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("addTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::AddTask)
;
                        }
                        GeneratedField::SubtractTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("subtractTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SubtractTask)
;
                        }
                        GeneratedField::TwapTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("twapTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::TwapTask)
;
                        }
                        GeneratedField::SerumSwapTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("serumSwapTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SerumSwapTask)
;
                        }
                        GeneratedField::PowTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("powTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::PowTask)
;
                        }
                        GeneratedField::LendingRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lendingRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::LendingRateTask)
;
                        }
                        GeneratedField::MangoPerpMarketTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mangoPerpMarketTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MangoPerpMarketTask)
;
                        }
                        GeneratedField::JupiterSwapTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("jupiterSwapTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::JupiterSwapTask)
;
                        }
                        GeneratedField::PerpMarketTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("perpMarketTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::PerpMarketTask)
;
                        }
                        GeneratedField::OracleTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("oracleTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::OracleTask)
;
                        }
                        GeneratedField::AnchorFetchTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("anchorFetchTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::AnchorFetchTask)
;
                        }
                        GeneratedField::SplStakePoolTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("splStakePoolTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SplStakePoolTask)
;
                        }
                        GeneratedField::SplTokenParseTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("splTokenParseTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SplTokenParseTask)
;
                        }
                        GeneratedField::UniswapExchangeRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("uniswapExchangeRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::UniswapExchangeRateTask)
;
                        }
                        GeneratedField::SushiswapExchangeRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("sushiswapExchangeRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SushiswapExchangeRateTask)
;
                        }
                        GeneratedField::PancakeswapExchangeRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pancakeswapExchangeRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::PancakeswapExchangeRateTask)
;
                        }
                        GeneratedField::CacheTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("cacheTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::CacheTask)
;
                        }
                        GeneratedField::SysclockOffsetTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("sysclockOffsetTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SysclockOffsetTask)
;
                        }
                        GeneratedField::MarinadeStateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("marinadeStateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MarinadeStateTask)
;
                        }
                        GeneratedField::SolanaAccountDataFetchTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("solanaAccountDataFetchTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SolanaAccountDataFetchTask)
;
                        }
                        GeneratedField::BufferLayoutParseTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("bufferLayoutParseTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::BufferLayoutParseTask)
;
                        }
                        GeneratedField::CronParseTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("cronParseTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::CronParseTask)
;
                        }
                        GeneratedField::MinTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("minTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MinTask)
;
                        }
                        GeneratedField::HistoryFunctionTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("historyFunctionTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::HistoryFunctionTask)
;
                        }
                        GeneratedField::VwapTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("vwapTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::VwapTask)
;
                        }
                        GeneratedField::EwmaTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("ewmaTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::EwmaTask)
;
                        }
                        GeneratedField::ComparisonTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("comparisonTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::ComparisonTask)
;
                        }
                        GeneratedField::RoundTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("roundTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::RoundTask)
;
                        }
                        GeneratedField::BoundTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("boundTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::BoundTask)
;
                        }
                        GeneratedField::SecretsTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("secretsTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SecretsTask)
;
                        }
                        GeneratedField::SanctumLstPriceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("sanctumLstPriceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SanctumLstPriceTask)
;
                        }
                        GeneratedField::OndoUsdyTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("ondoUsdyTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::OndoUsdyTask)
;
                        }
                        GeneratedField::MeteoraSwapTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("meteoraSwapTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MeteoraSwapTask)
;
                        }
                        GeneratedField::UnixTimeTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("unixTimeTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::UnixTimeTask)
;
                        }
                        GeneratedField::MapleFinanceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("mapleFinanceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::MapleFinanceTask)
;
                        }
                        GeneratedField::GlyphTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("glyphTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::GlyphTask)
;
                        }
                        GeneratedField::CorexTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("corexTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::CorexTask)
;
                        }
                        GeneratedField::LlmTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("llmTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::LlmTask)
;
                        }
                        GeneratedField::SolayerSusdTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("solayerSusdTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SolayerSusdTask)
;
                        }
                        GeneratedField::CurveFinanceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("curveFinanceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::CurveFinanceTask)
;
                        }
                        GeneratedField::TurboEthRedemptionRateTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("turboEthRedemptionRateTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::TurboEthRedemptionRateTask)
;
                        }
                        GeneratedField::BitFluxTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("bitFluxTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::BitFluxTask)
;
                        }
                        GeneratedField::FragmetricTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("fragmetricTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::FragmetricTask)
;
                        }
                        GeneratedField::AftermathTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aftermathTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::AftermathTask)
;
                        }
                        GeneratedField::EtherfuseTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("etherfuseTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::EtherfuseTask)
;
                        }
                        GeneratedField::LstHistoricalYieldTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("lstHistoricalYieldTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::LstHistoricalYieldTask)
;
                        }
                        GeneratedField::PumpAmmTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pumpAmmTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::PumpAmmTask)
;
                        }
                        GeneratedField::PumpAmmLpTokenPriceTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("pumpAmmLpTokenPriceTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::PumpAmmLpTokenPriceTask)
;
                        }
                        GeneratedField::ExponentTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("exponentTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::ExponentTask)
;
                        }
                        GeneratedField::ExponentPtLinearPricingTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("exponentPtLinearPricingTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::ExponentPtLinearPricingTask)
;
                        }
                        GeneratedField::SolanaToken2022ExtensionTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("solanaToken2022ExtensionTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SolanaToken2022ExtensionTask)
;
                        }
                        GeneratedField::SwitchboardSurgeTask => {
                            if task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("switchboardSurgeTask"));
                            }
                            task__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::task::Task::SwitchboardSurgeTask)
;
                        }
                    }
                }
                Ok(oracle_job::Task {
                    task: task__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.Task", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::TurboEthRedemptionRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.provider.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.TurboEthRedemptionRateTask", len)?;
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::TurboEthRedemptionRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "provider",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Provider,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "provider" => Ok(GeneratedField::Provider),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::TurboEthRedemptionRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.TurboEthRedemptionRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::TurboEthRedemptionRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut provider__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::TurboEthRedemptionRateTask {
                    provider: provider__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.TurboEthRedemptionRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::TwapTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.aggregator_pubkey.is_some() {
            len += 1;
        }
        if self.period.is_some() {
            len += 1;
        }
        if self.weight_by_propagation_time.is_some() {
            len += 1;
        }
        if self.min_samples.is_some() {
            len += 1;
        }
        if self.ending_unix_timestamp.is_some() {
            len += 1;
        }
        if self.ending_unix_timestamp_task.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.TwapTask", len)?;
        if let Some(v) = self.aggregator_pubkey.as_ref() {
            struct_ser.serialize_field("aggregatorPubkey", v)?;
        }
        if let Some(v) = self.period.as_ref() {
            struct_ser.serialize_field("period", v)?;
        }
        if let Some(v) = self.weight_by_propagation_time.as_ref() {
            struct_ser.serialize_field("weightByPropagationTime", v)?;
        }
        if let Some(v) = self.min_samples.as_ref() {
            struct_ser.serialize_field("minSamples", v)?;
        }
        if let Some(v) = self.ending_unix_timestamp.as_ref() {
            struct_ser.serialize_field("endingUnixTimestamp", v)?;
        }
        if let Some(v) = self.ending_unix_timestamp_task.as_ref() {
            struct_ser.serialize_field("endingUnixTimestampTask", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::TwapTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "aggregator_pubkey",
            "aggregatorPubkey",
            "period",
            "weight_by_propagation_time",
            "weightByPropagationTime",
            "min_samples",
            "minSamples",
            "ending_unix_timestamp",
            "endingUnixTimestamp",
            "ending_unix_timestamp_task",
            "endingUnixTimestampTask",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            AggregatorPubkey,
            Period,
            WeightByPropagationTime,
            MinSamples,
            EndingUnixTimestamp,
            EndingUnixTimestampTask,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "period" => Ok(GeneratedField::Period),
                            "weightByPropagationTime" | "weight_by_propagation_time" => Ok(GeneratedField::WeightByPropagationTime),
                            "minSamples" | "min_samples" => Ok(GeneratedField::MinSamples),
                            "endingUnixTimestamp" | "ending_unix_timestamp" => Ok(GeneratedField::EndingUnixTimestamp),
                            "endingUnixTimestampTask" | "ending_unix_timestamp_task" => Ok(GeneratedField::EndingUnixTimestampTask),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::TwapTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.TwapTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::TwapTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut aggregator_pubkey__ = None;
                let mut period__ = None;
                let mut weight_by_propagation_time__ = None;
                let mut min_samples__ = None;
                let mut ending_unix_timestamp__ = None;
                let mut ending_unix_timestamp_task__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::AggregatorPubkey => {
                            if aggregator_pubkey__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            aggregator_pubkey__ = map_.next_value()?;
                        }
                        GeneratedField::Period => {
                            if period__.is_some() {
                                return Err(serde::de::Error::duplicate_field("period"));
                            }
                            period__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::WeightByPropagationTime => {
                            if weight_by_propagation_time__.is_some() {
                                return Err(serde::de::Error::duplicate_field("weightByPropagationTime"));
                            }
                            weight_by_propagation_time__ = map_.next_value()?;
                        }
                        GeneratedField::MinSamples => {
                            if min_samples__.is_some() {
                                return Err(serde::de::Error::duplicate_field("minSamples"));
                            }
                            min_samples__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::EndingUnixTimestamp => {
                            if ending_unix_timestamp__.is_some() {
                                return Err(serde::de::Error::duplicate_field("endingUnixTimestamp"));
                            }
                            ending_unix_timestamp__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::EndingUnixTimestampTask => {
                            if ending_unix_timestamp_task__.is_some() {
                                return Err(serde::de::Error::duplicate_field("endingUnixTimestampTask"));
                            }
                            ending_unix_timestamp_task__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::TwapTask {
                    aggregator_pubkey: aggregator_pubkey__,
                    period: period__,
                    weight_by_propagation_time: weight_by_propagation_time__,
                    min_samples: min_samples__,
                    ending_unix_timestamp: ending_unix_timestamp__,
                    ending_unix_timestamp_task: ending_unix_timestamp_task__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.TwapTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::UniswapExchangeRateTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.in_token_address.is_some() {
            len += 1;
        }
        if self.out_token_address.is_some() {
            len += 1;
        }
        if self.in_token_amount.is_some() {
            len += 1;
        }
        if self.slippage.is_some() {
            len += 1;
        }
        if self.provider.is_some() {
            len += 1;
        }
        if self.version.is_some() {
            len += 1;
        }
        if self.router_address.is_some() {
            len += 1;
        }
        if self.factory_address.is_some() {
            len += 1;
        }
        if self.quoter_address.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.UniswapExchangeRateTask", len)?;
        if let Some(v) = self.in_token_address.as_ref() {
            struct_ser.serialize_field("inTokenAddress", v)?;
        }
        if let Some(v) = self.out_token_address.as_ref() {
            struct_ser.serialize_field("outTokenAddress", v)?;
        }
        if let Some(v) = self.in_token_amount.as_ref() {
            struct_ser.serialize_field("inTokenAmount", v)?;
        }
        if let Some(v) = self.slippage.as_ref() {
            struct_ser.serialize_field("slippage", v)?;
        }
        if let Some(v) = self.provider.as_ref() {
            struct_ser.serialize_field("provider", v)?;
        }
        if let Some(v) = self.version.as_ref() {
            let v = oracle_job::uniswap_exchange_rate_task::Version::try_from(*v)
                .map_err(|_| serde::ser::Error::custom(format!("Invalid variant {}", *v)))?;
            struct_ser.serialize_field("version", &v)?;
        }
        if let Some(v) = self.router_address.as_ref() {
            struct_ser.serialize_field("routerAddress", v)?;
        }
        if let Some(v) = self.factory_address.as_ref() {
            struct_ser.serialize_field("factoryAddress", v)?;
        }
        if let Some(v) = self.quoter_address.as_ref() {
            struct_ser.serialize_field("quoterAddress", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::UniswapExchangeRateTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "in_token_address",
            "inTokenAddress",
            "out_token_address",
            "outTokenAddress",
            "in_token_amount",
            "inTokenAmount",
            "slippage",
            "provider",
            "version",
            "router_address",
            "routerAddress",
            "factory_address",
            "factoryAddress",
            "quoter_address",
            "quoterAddress",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            InTokenAddress,
            OutTokenAddress,
            InTokenAmount,
            Slippage,
            Provider,
            Version,
            RouterAddress,
            FactoryAddress,
            QuoterAddress,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "inTokenAddress" | "in_token_address" => Ok(GeneratedField::InTokenAddress),
                            "outTokenAddress" | "out_token_address" => Ok(GeneratedField::OutTokenAddress),
                            "inTokenAmount" | "in_token_amount" => Ok(GeneratedField::InTokenAmount),
                            "slippage" => Ok(GeneratedField::Slippage),
                            "provider" => Ok(GeneratedField::Provider),
                            "version" => Ok(GeneratedField::Version),
                            "routerAddress" | "router_address" => Ok(GeneratedField::RouterAddress),
                            "factoryAddress" | "factory_address" => Ok(GeneratedField::FactoryAddress),
                            "quoterAddress" | "quoter_address" => Ok(GeneratedField::QuoterAddress),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::UniswapExchangeRateTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.UniswapExchangeRateTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::UniswapExchangeRateTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut in_token_address__ = None;
                let mut out_token_address__ = None;
                let mut in_token_amount__ = None;
                let mut slippage__ = None;
                let mut provider__ = None;
                let mut version__ = None;
                let mut router_address__ = None;
                let mut factory_address__ = None;
                let mut quoter_address__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::InTokenAddress => {
                            if in_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAddress"));
                            }
                            in_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::OutTokenAddress => {
                            if out_token_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("outTokenAddress"));
                            }
                            out_token_address__ = map_.next_value()?;
                        }
                        GeneratedField::InTokenAmount => {
                            if in_token_amount__.is_some() {
                                return Err(serde::de::Error::duplicate_field("inTokenAmount"));
                            }
                            in_token_amount__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Slippage => {
                            if slippage__.is_some() {
                                return Err(serde::de::Error::duplicate_field("slippage"));
                            }
                            slippage__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Provider => {
                            if provider__.is_some() {
                                return Err(serde::de::Error::duplicate_field("provider"));
                            }
                            provider__ = map_.next_value()?;
                        }
                        GeneratedField::Version => {
                            if version__.is_some() {
                                return Err(serde::de::Error::duplicate_field("version"));
                            }
                            version__ = map_.next_value::<::std::option::Option<oracle_job::uniswap_exchange_rate_task::Version>>()?.map(|x| x as i32);
                        }
                        GeneratedField::RouterAddress => {
                            if router_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("routerAddress"));
                            }
                            router_address__ = map_.next_value()?;
                        }
                        GeneratedField::FactoryAddress => {
                            if factory_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("factoryAddress"));
                            }
                            factory_address__ = map_.next_value()?;
                        }
                        GeneratedField::QuoterAddress => {
                            if quoter_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("quoterAddress"));
                            }
                            quoter_address__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::UniswapExchangeRateTask {
                    in_token_address: in_token_address__,
                    out_token_address: out_token_address__,
                    in_token_amount: in_token_amount__,
                    slippage: slippage__,
                    provider: provider__,
                    version: version__,
                    router_address: router_address__,
                    factory_address: factory_address__,
                    quoter_address: quoter_address__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.UniswapExchangeRateTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::uniswap_exchange_rate_task::Version {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let variant = match self {
            Self::V2Deprecated => "VERSION_V2_DEPRECATED",
            Self::V3Deprecated => "VERSION_V3_DEPRECATED",
            Self::V2 => "VERSION_V2",
            Self::V3 => "VERSION_V3",
        };
        serializer.serialize_str(variant)
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::uniswap_exchange_rate_task::Version {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "VERSION_V2_DEPRECATED",
            "VERSION_V3_DEPRECATED",
            "VERSION_V2",
            "VERSION_V3",
        ];

        struct GeneratedVisitor;

        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::uniswap_exchange_rate_task::Version;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "expected one of: {:?}", &FIELDS)
            }

            fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Signed(v), &self)
                    })
            }

            fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i32::try_from(v)
                    .ok()
                    .and_then(|x| x.try_into().ok())
                    .ok_or_else(|| {
                        serde::de::Error::invalid_value(serde::de::Unexpected::Unsigned(v), &self)
                    })
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    "VERSION_V2_DEPRECATED" => Ok(oracle_job::uniswap_exchange_rate_task::Version::V2Deprecated),
                    "VERSION_V3_DEPRECATED" => Ok(oracle_job::uniswap_exchange_rate_task::Version::V3Deprecated),
                    "VERSION_V2" => Ok(oracle_job::uniswap_exchange_rate_task::Version::V2),
                    "VERSION_V3" => Ok(oracle_job::uniswap_exchange_rate_task::Version::V3),
                    _ => Err(serde::de::Error::unknown_variant(value, FIELDS)),
                }
            }
        }
        deserializer.deserialize_any(GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::UnixTimeTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.offset.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.UnixTimeTask", len)?;
        if let Some(v) = self.offset.as_ref() {
            struct_ser.serialize_field("offset", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::UnixTimeTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "offset",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Offset,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "offset" => Ok(GeneratedField::Offset),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::UnixTimeTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.UnixTimeTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::UnixTimeTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut offset__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Offset => {
                            if offset__.is_some() {
                                return Err(serde::de::Error::duplicate_field("offset"));
                            }
                            offset__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::UnixTimeTask {
                    offset: offset__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.UnixTimeTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::ValueTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.value.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.ValueTask", len)?;
        if let Some(v) = self.value.as_ref() {
            match v {
                oracle_job::value_task::Value::Value(v) => {
                    struct_ser.serialize_field("value", v)?;
                }
                oracle_job::value_task::Value::AggregatorPubkey(v) => {
                    struct_ser.serialize_field("aggregatorPubkey", v)?;
                }
                oracle_job::value_task::Value::Big(v) => {
                    struct_ser.serialize_field("big", v)?;
                }
                oracle_job::value_task::Value::Hex(v) => {
                    struct_ser.serialize_field("hex", v)?;
                }
                oracle_job::value_task::Value::Utf8(v) => {
                    struct_ser.serialize_field("utf8", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::ValueTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "value",
            "aggregator_pubkey",
            "aggregatorPubkey",
            "big",
            "hex",
            "utf8",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Value,
            AggregatorPubkey,
            Big,
            Hex,
            Utf8,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "value" => Ok(GeneratedField::Value),
                            "aggregatorPubkey" | "aggregator_pubkey" => Ok(GeneratedField::AggregatorPubkey),
                            "big" => Ok(GeneratedField::Big),
                            "hex" => Ok(GeneratedField::Hex),
                            "utf8" => Ok(GeneratedField::Utf8),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::ValueTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.ValueTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::ValueTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut value__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Value => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("value"));
                            }
                            value__ = map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| oracle_job::value_task::Value::Value(x.0));
                        }
                        GeneratedField::AggregatorPubkey => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("aggregatorPubkey"));
                            }
                            value__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::value_task::Value::AggregatorPubkey);
                        }
                        GeneratedField::Big => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("big"));
                            }
                            value__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::value_task::Value::Big);
                        }
                        GeneratedField::Hex => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("hex"));
                            }
                            value__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::value_task::Value::Hex);
                        }
                        GeneratedField::Utf8 => {
                            if value__.is_some() {
                                return Err(serde::de::Error::duplicate_field("utf8"));
                            }
                            value__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::value_task::Value::Utf8);
                        }
                    }
                }
                Ok(oracle_job::ValueTask {
                    value: value__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.ValueTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::VwapTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.price_aggregator_address.is_some() {
            len += 1;
        }
        if self.volume_aggregator_address.is_some() {
            len += 1;
        }
        if self.period.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.VwapTask", len)?;
        if let Some(v) = self.price_aggregator_address.as_ref() {
            struct_ser.serialize_field("priceAggregatorAddress", v)?;
        }
        if let Some(v) = self.volume_aggregator_address.as_ref() {
            struct_ser.serialize_field("volumeAggregatorAddress", v)?;
        }
        if let Some(v) = self.period.as_ref() {
            struct_ser.serialize_field("period", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::VwapTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "price_aggregator_address",
            "priceAggregatorAddress",
            "volume_aggregator_address",
            "volumeAggregatorAddress",
            "period",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            PriceAggregatorAddress,
            VolumeAggregatorAddress,
            Period,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "priceAggregatorAddress" | "price_aggregator_address" => Ok(GeneratedField::PriceAggregatorAddress),
                            "volumeAggregatorAddress" | "volume_aggregator_address" => Ok(GeneratedField::VolumeAggregatorAddress),
                            "period" => Ok(GeneratedField::Period),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::VwapTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.VwapTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::VwapTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut price_aggregator_address__ = None;
                let mut volume_aggregator_address__ = None;
                let mut period__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::PriceAggregatorAddress => {
                            if price_aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("priceAggregatorAddress"));
                            }
                            price_aggregator_address__ = map_.next_value()?;
                        }
                        GeneratedField::VolumeAggregatorAddress => {
                            if volume_aggregator_address__.is_some() {
                                return Err(serde::de::Error::duplicate_field("volumeAggregatorAddress"));
                            }
                            volume_aggregator_address__ = map_.next_value()?;
                        }
                        GeneratedField::Period => {
                            if period__.is_some() {
                                return Err(serde::de::Error::duplicate_field("period"));
                            }
                            period__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                    }
                }
                Ok(oracle_job::VwapTask {
                    price_aggregator_address: price_aggregator_address__,
                    volume_aggregator_address: volume_aggregator_address__,
                    period: period__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.VwapTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::WebsocketTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.url.is_some() {
            len += 1;
        }
        if self.subscription.is_some() {
            len += 1;
        }
        if self.max_data_age_seconds.is_some() {
            len += 1;
        }
        if self.filter.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.WebsocketTask", len)?;
        if let Some(v) = self.url.as_ref() {
            struct_ser.serialize_field("url", v)?;
        }
        if let Some(v) = self.subscription.as_ref() {
            struct_ser.serialize_field("subscription", v)?;
        }
        if let Some(v) = self.max_data_age_seconds.as_ref() {
            struct_ser.serialize_field("maxDataAgeSeconds", v)?;
        }
        if let Some(v) = self.filter.as_ref() {
            struct_ser.serialize_field("filter", v)?;
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::WebsocketTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "url",
            "subscription",
            "max_data_age_seconds",
            "maxDataAgeSeconds",
            "filter",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            Url,
            Subscription,
            MaxDataAgeSeconds,
            Filter,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "url" => Ok(GeneratedField::Url),
                            "subscription" => Ok(GeneratedField::Subscription),
                            "maxDataAgeSeconds" | "max_data_age_seconds" => Ok(GeneratedField::MaxDataAgeSeconds),
                            "filter" => Ok(GeneratedField::Filter),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::WebsocketTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.WebsocketTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::WebsocketTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut url__ = None;
                let mut subscription__ = None;
                let mut max_data_age_seconds__ = None;
                let mut filter__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::Url => {
                            if url__.is_some() {
                                return Err(serde::de::Error::duplicate_field("url"));
                            }
                            url__ = map_.next_value()?;
                        }
                        GeneratedField::Subscription => {
                            if subscription__.is_some() {
                                return Err(serde::de::Error::duplicate_field("subscription"));
                            }
                            subscription__ = map_.next_value()?;
                        }
                        GeneratedField::MaxDataAgeSeconds => {
                            if max_data_age_seconds__.is_some() {
                                return Err(serde::de::Error::duplicate_field("maxDataAgeSeconds"));
                            }
                            max_data_age_seconds__ = 
                                map_.next_value::<::std::option::Option<::pbjson::private::NumberDeserialize<_>>>()?.map(|x| x.0)
                            ;
                        }
                        GeneratedField::Filter => {
                            if filter__.is_some() {
                                return Err(serde::de::Error::duplicate_field("filter"));
                            }
                            filter__ = map_.next_value()?;
                        }
                    }
                }
                Ok(oracle_job::WebsocketTask {
                    url: url__,
                    subscription: subscription__,
                    max_data_age_seconds: max_data_age_seconds__,
                    filter: filter__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.WebsocketTask", FIELDS, GeneratedVisitor)
    }
}
impl serde::Serialize for oracle_job::XStepPriceTask {
    #[allow(deprecated)]
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut len = 0;
        if self.step_source.is_some() {
            len += 1;
        }
        let mut struct_ser = serializer.serialize_struct("oracle_job.OracleJob.XStepPriceTask", len)?;
        if let Some(v) = self.step_source.as_ref() {
            match v {
                oracle_job::x_step_price_task::StepSource::StepJob(v) => {
                    struct_ser.serialize_field("stepJob", v)?;
                }
                oracle_job::x_step_price_task::StepSource::StepAggregatorPubkey(v) => {
                    struct_ser.serialize_field("stepAggregatorPubkey", v)?;
                }
            }
        }
        struct_ser.end()
    }
}
impl<'de> serde::Deserialize<'de> for oracle_job::XStepPriceTask {
    #[allow(deprecated)]
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        const FIELDS: &[&str] = &[
            "step_job",
            "stepJob",
            "step_aggregator_pubkey",
            "stepAggregatorPubkey",
        ];

        #[allow(clippy::enum_variant_names)]
        enum GeneratedField {
            StepJob,
            StepAggregatorPubkey,
        }
        impl<'de> serde::Deserialize<'de> for GeneratedField {
            fn deserialize<D>(deserializer: D) -> std::result::Result<GeneratedField, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct GeneratedVisitor;

                impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
                    type Value = GeneratedField;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(formatter, "expected one of: {:?}", &FIELDS)
                    }

                    #[allow(unused_variables)]
                    fn visit_str<E>(self, value: &str) -> std::result::Result<GeneratedField, E>
                    where
                        E: serde::de::Error,
                    {
                        match value {
                            "stepJob" | "step_job" => Ok(GeneratedField::StepJob),
                            "stepAggregatorPubkey" | "step_aggregator_pubkey" => Ok(GeneratedField::StepAggregatorPubkey),
                            _ => Err(serde::de::Error::unknown_field(value, FIELDS)),
                        }
                    }
                }
                deserializer.deserialize_identifier(GeneratedVisitor)
            }
        }
        struct GeneratedVisitor;
        impl<'de> serde::de::Visitor<'de> for GeneratedVisitor {
            type Value = oracle_job::XStepPriceTask;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("struct oracle_job.OracleJob.XStepPriceTask")
            }

            fn visit_map<V>(self, mut map_: V) -> std::result::Result<oracle_job::XStepPriceTask, V::Error>
                where
                    V: serde::de::MapAccess<'de>,
            {
                let mut step_source__ = None;
                while let Some(k) = map_.next_key()? {
                    match k {
                        GeneratedField::StepJob => {
                            if step_source__.is_some() {
                                return Err(serde::de::Error::duplicate_field("stepJob"));
                            }
                            step_source__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::x_step_price_task::StepSource::StepJob)
;
                        }
                        GeneratedField::StepAggregatorPubkey => {
                            if step_source__.is_some() {
                                return Err(serde::de::Error::duplicate_field("stepAggregatorPubkey"));
                            }
                            step_source__ = map_.next_value::<::std::option::Option<_>>()?.map(oracle_job::x_step_price_task::StepSource::StepAggregatorPubkey);
                        }
                    }
                }
                Ok(oracle_job::XStepPriceTask {
                    step_source: step_source__,
                })
            }
        }
        deserializer.deserialize_struct("oracle_job.OracleJob.XStepPriceTask", FIELDS, GeneratedVisitor)
    }
}
