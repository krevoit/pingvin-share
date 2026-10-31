import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Divider,
  Grid,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { ModalsContextProps } from "@mantine/modals/lib/context";
import moment from "moment";
import { useEffect, useState } from "react";
import { TbAlertCircle, TbCheck, TbCopy, TbTrash } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import useTranslate, {
  translateOutsideContext,
} from "../../../hooks/useTranslate.hook";
import directLinkService from "../../../services/directLink.service";
import { FileMetaData } from "../../../types/File.type";
import {
  CreatedDirectLink,
  DirectLink,
  directLinkStatus,
} from "../../../types/directLink.type";
import toast from "../../../utils/toast.util";

const showDirectLinksModal = (
  modals: ModalsContextProps,
  shareId: string,
  file: FileMetaData,
  origin: string,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("share.direct-links.title", { name: file.name }),
    size: "xl",
    children: <Body shareId={shareId} file={file} origin={origin} />,
  });
};

export const CopyableCommand = ({ value }: { value: string }) => (
  <Group noWrap spacing={4} align="flex-start">
    <Code
      block
      sx={{ flex: 1, wordBreak: "break-all", whiteSpace: "pre-wrap" }}
    >
      {value}
    </Code>
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
          <ActionIcon onClick={copy} color={copied ? "teal" : "gray"}>
            {copied ? <TbCheck /> : <TbCopy />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  </Group>
);

const statusColor: Record<string, string> = {
  active: "green",
  revoked: "red",
  expired: "gray",
  "used-up": "orange",
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
// PowerShell treats the typographic quotes ‘ ’ ‚ ‛ like ' inside single-quoted
// strings, so all of them must be doubled to stay inside the string.
const powershellQuote = (value: string) =>
  `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;

// File name for -OutFile: plain ASCII only, nothing a shell could interpret.
const safeOutFileName = (name: string) =>
  (name.split("/").pop() ?? name).replace(/[^\w.\- ]/g, "_").trim() ||
  "download";

const Body = ({
  shareId,
  file,
  origin,
}: {
  shareId: string;
  file: FileMetaData;
  origin: string;
}) => {
  const t = useTranslate();
  const [links, setLinks] = useState<DirectLink[]>();
  const [created, setCreated] = useState<CreatedDirectLink>();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm({
    initialValues: {
      name: "",
      expirationValue: 1 as number | "",
      expirationUnit: "hours",
      neverExpires: false,
      maxDownloads: 1 as number | "",
    },
    validate: {
      expirationValue: (value, values) =>
        !values.neverExpires && (!value || value < 1)
          ? t("common.error.invalid-number")
          : null,
      maxDownloads: (value) =>
        value !== "" && (value < 1 || !Number.isInteger(value))
          ? t("common.error.invalid-number")
          : null,
    },
  });

  const refresh = () =>
    directLinkService
      .list(shareId, file.id)
      .then(setLinks)
      .catch(toast.axiosError);

  useEffect(() => {
    refresh();
  }, []);

  const onSubmit = form.onSubmit(async (values) => {
    setSubmitting(true);
    try {
      const link = await directLinkService.create(shareId, file.id, {
        name: values.name.trim() || undefined,
        expiration: values.neverExpires
          ? "never"
          : `${values.expirationValue}-${values.expirationUnit}`,
        maxDownloads:
          values.maxDownloads === "" ? undefined : values.maxDownloads,
      });
      setCreated(link);
      form.setFieldValue("name", "");
      await refresh();
    } catch (e) {
      toast.axiosError(e);
    } finally {
      setSubmitting(false);
    }
  });

  const revoke = async (link: DirectLink) => {
    try {
      await directLinkService.revoke(shareId, file.id, link.id);
      toast.success(t("share.direct-links.notify.revoked"));
      await refresh();
    } catch (e) {
      toast.axiosError(e);
    }
  };

  const revokeAll = async () => {
    try {
      await directLinkService.revokeAll(shareId, file.id);
      toast.success(t("share.direct-links.notify.revoked-all"));
      await refresh();
    } catch (e) {
      toast.axiosError(e);
    }
  };

  const createdUrl = created ? `${origin}${created.path}` : undefined;
  const activeCount =
    links?.filter((l) => directLinkStatus(l) === "active").length ?? 0;

  return (
    <Stack>
      <Text size="sm" color="dimmed">
        <FormattedMessage id="share.direct-links.description" />
      </Text>

      {created && createdUrl && (
        <Alert
          color="green"
          icon={<TbAlertCircle />}
          title={t("share.direct-links.created.title")}
          withCloseButton
          onClose={() => setCreated(undefined)}
        >
          <Stack spacing="xs">
            <Text size="sm">
              <FormattedMessage id="share.direct-links.created.once" />
            </Text>
            <CopyableCommand value={createdUrl} />
            <Text size="xs" weight={600}>
              curl
            </Text>
            <CopyableCommand value={`curl -fLOJ ${shellQuote(createdUrl)}`} />
            <Text size="xs" weight={600}>
              wget
            </Text>
            <CopyableCommand
              value={`wget --content-disposition ${shellQuote(createdUrl)}`}
            />
            <Text size="xs" weight={600}>
              PowerShell
            </Text>
            <CopyableCommand
              value={`Invoke-WebRequest -Uri ${powershellQuote(createdUrl)} -OutFile ${powershellQuote(safeOutFileName(file.name))}`}
            />
          </Stack>
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <Stack spacing="xs">
          <Title order={5}>
            <FormattedMessage id="share.direct-links.create.title" />
          </Title>
          <Grid align="flex-end">
            <Grid.Col sm={4}>
              <TextInput
                variant="filled"
                maxLength={64}
                label={t("share.direct-links.create.name")}
                placeholder={t("share.direct-links.create.name.placeholder")}
                {...form.getInputProps("name")}
              />
            </Grid.Col>
            <Grid.Col xs={6} sm={2}>
              <NumberInput
                variant="filled"
                min={1}
                max={99999}
                precision={0}
                disabled={form.values.neverExpires}
                label={t("share.direct-links.create.expires-after")}
                {...form.getInputProps("expirationValue")}
              />
            </Grid.Col>
            <Grid.Col xs={6} sm={3}>
              <Select
                variant="filled"
                disabled={form.values.neverExpires}
                data={[
                  {
                    value: "minutes",
                    label: t("upload.modal.expires.minute-plural"),
                  },
                  {
                    value: "hours",
                    label: t("upload.modal.expires.hour-plural"),
                  },
                  {
                    value: "days",
                    label: t("upload.modal.expires.day-plural"),
                  },
                  {
                    value: "weeks",
                    label: t("upload.modal.expires.week-plural"),
                  },
                  {
                    value: "months",
                    label: t("upload.modal.expires.month-plural"),
                  },
                ]}
                {...form.getInputProps("expirationUnit")}
              />
            </Grid.Col>
            <Grid.Col sm={3}>
              <NumberInput
                variant="filled"
                min={1}
                max={1000000}
                precision={0}
                label={t("share.direct-links.create.max-downloads")}
                placeholder={t("share.direct-links.unlimited")}
                {...form.getInputProps("maxDownloads")}
              />
            </Grid.Col>
          </Grid>
          <Checkbox
            label={t("share.direct-links.create.never-expires")}
            {...form.getInputProps("neverExpires", { type: "checkbox" })}
          />
          <Text size="xs" color="dimmed">
            <FormattedMessage id="share.direct-links.create.hint" />
          </Text>
          <Group position="right">
            <Button type="submit" loading={submitting}>
              <FormattedMessage id="share.direct-links.create.submit" />
            </Button>
          </Group>
        </Stack>
      </form>

      <Divider />

      <Group position="apart">
        <Title order={5}>
          <FormattedMessage id="share.direct-links.list.title" />
        </Title>
        {activeCount > 0 && (
          <Button
            color="red"
            variant="light"
            size="xs"
            leftIcon={<TbTrash />}
            onClick={revokeAll}
          >
            <FormattedMessage id="share.direct-links.revoke-all" />
          </Button>
        )}
      </Group>

      {links && links.length === 0 && (
        <Text size="sm" color="dimmed">
          <FormattedMessage id="share.direct-links.list.empty" />
        </Text>
      )}

      {links && links.length > 0 && (
        <Box sx={{ display: "block", overflowX: "auto" }}>
          <Table fontSize="xs" verticalSpacing={6}>
            <thead>
              <tr>
                <th>{t("share.direct-links.table.name")}</th>
                <th>{t("share.direct-links.table.status")}</th>
                <th>{t("share.direct-links.table.downloads")}</th>
                <th>{t("share.direct-links.table.expires")}</th>
                <th>{t("share.direct-links.table.last-used")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => {
                const status = directLinkStatus(link);
                return (
                  <tr key={link.id}>
                    <td>
                      {link.name || (
                        <Text color="dimmed" span>
                          {moment(link.createdAt).format("lll")}
                        </Text>
                      )}
                    </td>
                    <td>
                      <Badge color={statusColor[status]} size="sm">
                        {t(`share.direct-links.status.${status}`)}
                      </Badge>
                    </td>
                    <td>
                      {link.downloadCount} / {link.maxDownloads ?? "∞"}
                    </td>
                    <td>
                      {link.expiresAt
                        ? moment(link.expiresAt).fromNow()
                        : t("share.direct-links.never")}
                    </td>
                    <td>
                      {link.lastUsedAt
                        ? `${moment(link.lastUsedAt).fromNow()}${link.lastUsedIp ? ` · ${link.lastUsedIp}` : ""}`
                        : "—"}
                    </td>
                    <td>
                      {status === "active" && (
                        <Tooltip label={t("share.direct-links.revoke")}>
                          <ActionIcon
                            color="red"
                            variant="light"
                            size={25}
                            onClick={() => revoke(link)}
                          >
                            <TbTrash />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Box>
      )}
    </Stack>
  );
};

export default showDirectLinksModal;
