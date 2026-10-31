import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Grid,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useModals } from "@mantine/modals";
import moment from "moment";
import { useEffect, useState } from "react";
import { TbAlertCircle, TbInfoCircle, TbPlus, TbTrash } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import CenterLoader from "../../components/core/CenterLoader";
import { HoverTip } from "../../components/core/HoverTip";
import { CopyableCommand } from "../../components/share/modals/showDirectLinksModal";
import useConfig from "../../hooks/config.hook";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import directLinkService from "../../services/directLink.service";
import {
  CliUploadToken,
  CreatedCliUploadToken,
  cliTokenStatus,
} from "../../types/directLink.type";
import { Timespan } from "../../types/timespan.type";
import toast from "../../utils/toast.util";

const statusColor: Record<string, string> = {
  active: "green",
  expired: "gray",
  "used-up": "orange",
};

const formatRelativeExpiration = (value: string, never: string) => {
  if (value === "never") return never;
  const [amount, unit] = value.split("-");
  return moment
    .duration(parseInt(amount), unit as moment.unitOfTime.DurationConstructor)
    .humanize();
};

const UsageExamples = ({ uploadUrl }: { uploadUrl: string }) => {
  const t = useTranslate();
  return (
    <Stack spacing={6}>
      <Text size="xs" weight={600}>
        {t("account.cli-uploads.example.single")}
      </Text>
      <CopyableCommand value={`curl -T ./file.zip ${uploadUrl}/`} />
      <Text size="xs" weight={600}>
        {t("account.cli-uploads.example.multiple")}
      </Text>
      <CopyableCommand
        value={`curl -F file=@a.txt -F file=@b.log ${uploadUrl}`}
      />
      <Text size="xs" weight={600}>
        {t("account.cli-uploads.example.pipe")}
      </Text>
      <CopyableCommand
        value={`tar cz ./logs | curl -T - ${uploadUrl}/logs.tar.gz`}
      />
      <Text size="xs" weight={600}>
        {t("account.cli-uploads.example.direct-link")}
      </Text>
      <CopyableCommand
        value={`curl -T ./file.zip "${uploadUrl}/file.zip?directLink=1&maxDownloads=1&linkExpiration=1-hour"`}
      />
      <Text size="xs" weight={600}>
        PowerShell
      </Text>
      <CopyableCommand
        value={`Invoke-RestMethod -Method Put -InFile .\\file.zip -Uri ${uploadUrl}/file.zip`}
      />
    </Stack>
  );
};

const CreateTokenModal = ({
  opened,
  onClose,
  onCreated,
  maxExpiration,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (token: CreatedCliUploadToken) => void;
  maxExpiration: Timespan;
}) => {
  const t = useTranslate();
  const [submitting, setSubmitting] = useState(false);
  const neverAllowed = maxExpiration.value === 0;

  const form = useForm({
    initialValues: {
      name: "",
      validValue: 15 as number | "",
      validUnit: "minutes",
      maxUses: 1 as number | "",
      shareValue: 7 as number | "",
      shareUnit: "days",
      shareNever: false,
    },
    validate: {
      validValue: (v) =>
        !v || v < 1 ? t("common.error.invalid-number") : null,
      maxUses: (v) =>
        v === "" || v < 0 || v > 1000 ? t("common.error.invalid-number") : null,
      shareValue: (v, values) =>
        !values.shareNever && (!v || v < 1)
          ? t("common.error.invalid-number")
          : null,
    },
  });

  const units = [
    { value: "minutes", label: t("upload.modal.expires.minute-plural") },
    { value: "hours", label: t("upload.modal.expires.hour-plural") },
    { value: "days", label: t("upload.modal.expires.day-plural") },
    { value: "weeks", label: t("upload.modal.expires.week-plural") },
    { value: "months", label: t("upload.modal.expires.month-plural") },
  ];

  const onSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const token = await directLinkService.createCliToken({
        name: values.name.trim() || undefined,
        expiration: `${values.validValue}-${values.validUnit}`,
        maxUses: values.maxUses as number,
        shareExpiration: values.shareNever
          ? "never"
          : `${values.shareValue}-${values.shareUnit}`,
      });
      form.reset();
      onCreated(token);
    } catch (e) {
      toast.axiosError(e);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("account.cli-uploads.modal.title")}
      size="lg"
    >
      <form onSubmit={onSubmit}>
        <Stack>
          <TextInput
            variant="filled"
            maxLength={64}
            label={t("account.cli-uploads.modal.name")}
            placeholder={t("account.cli-uploads.modal.name.placeholder")}
            {...form.getInputProps("name")}
          />
          <Grid align="flex-end">
            <Grid.Col xs={6}>
              <NumberInput
                variant="filled"
                min={1}
                max={99999}
                precision={0}
                label={t("account.cli-uploads.modal.valid-for")}
                description={t(
                  "account.cli-uploads.modal.valid-for.description",
                )}
                {...form.getInputProps("validValue")}
              />
            </Grid.Col>
            <Grid.Col xs={6}>
              <Select
                variant="filled"
                data={units}
                {...form.getInputProps("validUnit")}
              />
            </Grid.Col>
          </Grid>
          <NumberInput
            variant="filled"
            min={0}
            max={1000}
            precision={0}
            label={t("account.cli-uploads.modal.max-uses")}
            description={t("account.cli-uploads.modal.max-uses.description")}
            {...form.getInputProps("maxUses")}
          />
          <Grid align="flex-end">
            <Grid.Col xs={6}>
              <NumberInput
                variant="filled"
                min={1}
                max={99999}
                precision={0}
                disabled={form.values.shareNever}
                label={t("account.cli-uploads.modal.share-expiration")}
                description={
                  neverAllowed
                    ? undefined
                    : t("account.cli-uploads.modal.share-expiration.max", {
                        max: moment
                          .duration(maxExpiration.value, maxExpiration.unit)
                          .humanize(),
                      })
                }
                {...form.getInputProps("shareValue")}
              />
            </Grid.Col>
            <Grid.Col xs={6}>
              <Select
                variant="filled"
                disabled={form.values.shareNever}
                data={units}
                {...form.getInputProps("shareUnit")}
              />
            </Grid.Col>
          </Grid>
          {neverAllowed && (
            <Checkbox
              label={t("account.cli-uploads.modal.share-never")}
              {...form.getInputProps("shareNever", { type: "checkbox" })}
            />
          )}
          <Group position="right">
            <Button type="submit" loading={submitting}>
              <FormattedMessage id="common.button.create" />
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};

const CliUploads = () => {
  const t = useTranslate();
  const config = useConfig();
  const modals = useModals();
  const { user } = useUser();

  const [tokens, setTokens] = useState<CliUploadToken[]>();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedCliUploadToken>();

  const appUrl = config.get("general.appUrl");
  const origin =
    appUrl !== config.get("general.appUrl", true)
      ? appUrl
      : typeof window !== "undefined"
        ? window.location.origin
        : appUrl;

  const canShare = user?.allowShare !== false;

  const refresh = () =>
    directLinkService.listCliTokens().then(setTokens).catch(toast.axiosError);

  useEffect(() => {
    refresh();
  }, []);

  const deleteToken = (token: CliUploadToken) =>
    modals.openConfirmModal({
      title: t("account.cli-uploads.delete.title"),
      children: (
        <Text size="sm">
          <FormattedMessage id="account.cli-uploads.delete.description" />
        </Text>
      ),
      confirmProps: { color: "red" },
      labels: {
        confirm: t("common.button.delete"),
        cancel: t("common.button.cancel"),
      },
      onConfirm: async () => {
        try {
          await directLinkService.deleteCliToken(token.id);
          if (created?.id === token.id) setCreated(undefined);
          await refresh();
        } catch (e) {
          toast.axiosError(e);
        }
      },
    });

  if (!tokens) return <CenterLoader />;

  return (
    <>
      <Meta title={t("account.cli-uploads.title")} />
      <Group position="apart" align="baseline" mb={20}>
        <Group align="center" spacing={3}>
          <Title order={3}>
            <FormattedMessage id="account.cli-uploads.title" />
          </Title>
          <HoverTip label={t("account.cli-uploads.description")}>
            <ActionIcon color="blue">
              <TbInfoCircle />
            </ActionIcon>
          </HoverTip>
        </Group>
        {canShare && (
          <Button
            leftIcon={<TbPlus size={20} />}
            onClick={() => setCreateOpen(true)}
          >
            <FormattedMessage id="common.button.create" />
          </Button>
        )}
      </Group>

      <CreateTokenModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        maxExpiration={
          user?.isAdmin
            ? { value: 0, unit: "days" }
            : config.get("share.maxExpiration")
        }
        onCreated={(token) => {
          setCreateOpen(false);
          setCreated(token);
          refresh();
        }}
      />

      {created && (
        <Alert
          mb="xl"
          color="green"
          icon={<TbAlertCircle />}
          title={t("account.cli-uploads.created.title")}
          withCloseButton
          onClose={() => setCreated(undefined)}
        >
          <Stack spacing="xs">
            <Text size="sm">
              <FormattedMessage id="account.cli-uploads.created.once" />
            </Text>
            <UsageExamples
              uploadUrl={`${origin}/api/cli/upload/${created.token}`}
            />
          </Stack>
        </Alert>
      )}

      {tokens.length === 0 ? (
        <Center style={{ height: "50vh" }}>
          <Stack align="center" spacing={10}>
            <Title order={3}>
              <FormattedMessage id="account.cli-uploads.empty.title" />
            </Title>
            <Text align="center" color={canShare ? undefined : "dimmed"}>
              <FormattedMessage
                id={
                  canShare
                    ? "account.cli-uploads.empty.description"
                    : "account.cli-uploads.not-allowed"
                }
              />
            </Text>
          </Stack>
        </Center>
      ) : (
        <Box sx={{ display: "block", overflowX: "auto" }}>
          <Table>
            <thead>
              <tr>
                <th>{t("account.cli-uploads.table.name")}</th>
                <th>{t("account.cli-uploads.table.status")}</th>
                <th>{t("account.cli-uploads.table.uses")}</th>
                <th>{t("account.cli-uploads.table.expires")}</th>
                <th>{t("account.cli-uploads.table.share-expiration")}</th>
                <th>{t("account.cli-uploads.table.last-used")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const status = cliTokenStatus(token);
                return (
                  <tr key={token.id}>
                    <td>
                      {token.name || (
                        <Text color="dimmed" span>
                          {moment(token.createdAt).format("lll")}
                        </Text>
                      )}
                    </td>
                    <td>
                      <Badge color={statusColor[status]} size="sm">
                        {t(`account.cli-uploads.status.${status}`)}
                      </Badge>
                    </td>
                    <td>
                      {token.useCount} / {token.maxUses ?? "∞"}
                    </td>
                    <td>{moment(token.expiresAt).fromNow()}</td>
                    <td>
                      {formatRelativeExpiration(
                        token.shareExpiration,
                        t("share.direct-links.never"),
                      )}
                    </td>
                    <td>
                      {token.lastUsedAt
                        ? `${moment(token.lastUsedAt).fromNow()}${token.lastUsedIp ? ` · ${token.lastUsedIp}` : ""}`
                        : "—"}
                    </td>
                    <td>
                      <Group position="right">
                        <HoverTip label={t("account.cli-uploads.revoke")}>
                          <ActionIcon
                            color="red"
                            variant="light"
                            size={25}
                            onClick={() => deleteToken(token)}
                          >
                            <TbTrash />
                          </ActionIcon>
                        </HoverTip>
                      </Group>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Box>
      )}
    </>
  );
};

export default CliUploads;
